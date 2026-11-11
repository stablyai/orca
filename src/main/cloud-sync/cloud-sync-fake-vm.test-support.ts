// An in-memory cloud workspace that answers the orcad file RPCs cloud sync uses, so the real
// session (planner, writes, watch handling) runs against temp folders without a sandbox.
import { z } from 'zod'
import type { SyncCall } from './cloud-sync-remote'

const ParamsSchema = z.looseObject({
  relativePath: z.string().optional(),
  relativePaths: z.array(z.string()).optional(),
  candidatePaths: z.array(z.string()).optional(),
  includeIgnored: z.boolean().optional(),
  offset: z.number().optional(),
  length: z.number().optional()
})
import type { WatchSubscribe } from './cloud-sync-session'

export const VM_ROOT = '/vercel/sandbox/project'

export type FakeVm = {
  files: Map<string, { content: Buffer; mtime: number }>
  ignored: Set<string>
  calls: string[]
  statManySupported: boolean
  asleep: boolean
  write: (path: string, content: string, mtime?: number) => void
  remove: (path: string) => void
  /** Delivers a watch batch to every open subscription. */
  emitWatch: (events: unknown[]) => void
  call: SyncCall
  subscribe: WatchSubscribe
  openWatches: () => number
}

function codeError(code: string, message = code): Error {
  return Object.assign(new Error(message), { code })
}

export function createFakeVm(): FakeVm {
  const files = new Map<string, { content: Buffer; mtime: number }>()
  const ignored = new Set<string>()
  const calls: string[] = []
  const watches = new Set<(event: unknown) => void>()
  let clock = 1_000
  const vm: FakeVm = {
    files,
    ignored,
    calls,
    statManySupported: true,
    asleep: false,
    write(path, content, mtime) {
      files.set(path, { content: Buffer.from(content), mtime: mtime ?? ++clock })
    },
    remove(path) {
      files.delete(path)
    },
    emitWatch(events) {
      for (const listener of watches) {
        listener({ type: 'changed', worktree: 'id:ws', events })
      }
    },
    openWatches: () => watches.size,
    call: async <T>(method: string, params: unknown): Promise<T> => {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; the session validates every reply with zod, as it does real orcad replies.
      return (await answer(method, params)) as T
    },
    subscribe: async (_selector, handlers) => {
      watches.add(handlers.onEvent)
      handlers.onEvent({ type: 'ready' })
      return { close: () => watches.delete(handlers.onEvent) }
    }
  }
  async function answer(method: string, params: unknown): Promise<unknown> {
    calls.push(method)
    if (vm.asleep) {
      throw codeError('runtime_environment_asleep')
    }
    const p = ParamsSchema.parse(params)
    switch (method) {
      case 'worktree.list':
        return { worktrees: [{ id: 'repo::ws', path: VM_ROOT }] }
      case 'files.readDir': {
        const dir = String(p.relativePath)
        const names = new Map<string, boolean>()
        for (const path of files.keys()) {
          if (path.startsWith(`${dir}/`)) {
            const rest = path.slice(dir.length + 1)
            const [head, ...tail] = rest.split('/')
            names.set(head!, tail.length > 0 || names.get(head!) === true)
          }
        }
        if (names.size === 0) {
          throw new Error(`ENOENT: no such file or directory, scandir '${dir}'`)
        }
        return [...names].map(([name, isDirectory]) => ({ name, isDirectory, isSymlink: false }))
      }
      case 'files.listAll': {
        const candidates = p.candidatePaths
        return [...files.keys()].filter(
          (path) =>
            // Like orcad: gitignored files are listed unless includeIgnored is false.
            (p.includeIgnored !== false || !ignored.has(path)) &&
            !path.startsWith('.context/') &&
            (!candidates || candidates.includes(path))
        )
      }
      case 'files.statMany': {
        if (!vm.statManySupported) {
          throw codeError('method_not_found', 'Unknown method: files.statMany')
        }
        return {
          entries: (p.relativePaths ?? []).map((path) => {
            const file = files.get(path)
            return file ? { size: file.content.length, mtime: file.mtime, type: 'file' } : null
          })
        }
      }
      case 'files.stat': {
        const file = files.get(String(p.relativePath))
        if (!file) {
          throw new Error('ENOENT: no such file')
        }
        return { size: file.content.length, mtime: file.mtime, isDirectory: false }
      }
      case 'files.readChunk': {
        const file = files.get(String(p.relativePath))
        if (!file) {
          throw new Error('ENOENT: no such file')
        }
        const offset = Number(p.offset)
        const slice = file.content.subarray(offset, offset + Number(p.length))
        return {
          contentBase64: slice.toString('base64'),
          bytesRead: slice.length,
          eof: offset + slice.length >= file.content.length
        }
      }
      default:
        throw codeError('method_not_found', `Unknown method: ${method}`)
    }
  }
  return vm
}
