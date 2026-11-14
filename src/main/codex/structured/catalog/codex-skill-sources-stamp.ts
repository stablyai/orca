import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { findSkillFiles } from '../../../skills/discovery/skill-root-file-walk'
import { runSkillCandidateTasks } from '../../../skills/filesystem/skill-candidate-concurrency'
import {
  getSystemCodexHomePath,
  resolveOrcaManagedCodexHomePath
} from '../../configuration/homes/codex-home-paths'
import { readCopiedResourceSource } from '../../configuration/homes/codex-managed-home-resource-copy-marker'
import { parse as parseToml } from 'smol-toml'
import { waitForPromiseWithSignal } from '../../../../shared/abort-signal-reason'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'

// Mirrors Codex's skill walk (codex-rs ext/skills loader: MAX_SCAN_DEPTH).
const CODEX_SKILL_SCAN_DEPTH = 6
/** Menu bursts across chats and phones share one walk per root. */
const ROOT_STAMP_REUSE_MS = 1_000
/** A slow read is reused longer, keeping a huge root's I/O near 2% of wall time. */
const ROOT_STAMP_REUSE_PER_WALK_MS = 50
/** A read that timed out (hung network drive) is not retried until this passes. */
const TIMED_OUT_ROOT_RETRY_MS = 60_000
/** Half the libuv pool, so a stamp never starves other main-process I/O. */
const STAT_CONCURRENCY = 2
/** Per read and overall: a slow root (network drive) yields no stamp; the TTL rescan covers it. */
const STAMP_TIMEOUT_MS = 2_000

type Remembered<T> = { until: number; value: Promise<T> }

// Every filesystem read goes through one of these: a hung mount parks at most one libuv worker per key.
function createTimedMemo<T>(now: () => number) {
  const entries = new Map<string, Remembered<T>>()
  return (key: string, caller: AbortSignal, read: (signal: AbortSignal) => Promise<T>) => {
    const at = now()
    let entry = entries.get(key)
    if (!entry || at >= entry.until) {
      for (const [path, old] of entries) {
        if (at >= old.until) {
          entries.delete(path)
        }
      }
      // Shared work owns only its time limit, so one chat's cancel never fails another's read.
      const limit = AbortSignal.timeout(STAMP_TIMEOUT_MS)
      // A hung readdir or stat never settles on abort; racing lets the timed-out mark replace it.
      const value = waitForPromiseWithSignal(read(limit), limit)
      // In flight: concurrent menus join this read.
      const created: Remembered<T> = { until: Number.POSITIVE_INFINITY, value }
      value.then(
        () => {
          const done = now()
          created.until =
            done + Math.max(ROOT_STAMP_REUSE_MS, (done - at) * ROOT_STAMP_REUSE_PER_WALK_MS)
        },
        () => {
          created.until = now() + TIMED_OUT_ROOT_RETRY_MS
        }
      )
      entries.set(key, created)
      entry = created
    }
    return waitForPromiseWithSignal(entry.value, caller)
  }
}

/** Fingerprint of everything Codex reads skills from; a changed value means skills/list may differ. */
export function createCodexSkillSourcesStamp(
  options: {
    now?: () => number
    homeDir?: () => string
    systemCodexHome?: () => string
    managedCodexHome?: () => string
  } = {}
) {
  const now = options.now ?? Date.now
  const home = options.homeDir ?? homedir
  const systemCodexHome = options.systemCodexHome ?? getSystemCodexHomePath
  const managedCodexHome = options.managedCodexHome ?? resolveOrcaManagedCodexHomePath
  const roots = createTimedMemo<string>(now)
  const chains = createTimedMemo<string[]>(now)
  const markers = createTimedMemo<string | null>(now)
  const configReads = createTimedMemo<string>(now)
  const configs = new Map<string, { key: string; digest: string }>()

  const rootStamp = (root: string, caller: AbortSignal): Promise<string> =>
    roots(root, caller, async (signal) => {
      const files = await findSkillFiles(root, CODEX_SKILL_SCAN_DEPTH, signal, {
        skipHiddenDirectories: true,
        stopAtSkillDirectories: true
      })
      const facts = await runSkillCandidateTasks(
        files.map((file) => async () => {
          signal.throwIfAborted()
          // ctime catches copies that preserve mtime (cp -p, unpacked archives).
          const info = await stat(file).catch(() => null)
          return info ? `${file}:${info.ino}:${info.ctimeMs}:${info.size}` : `${file}:-`
        }),
        STAT_CONCURRENCY
      )
      return facts.join('\n')
    })

  // Only skill and plugin tables matter: Orca adds a trust entry each time a chat opens in a new folder.
  const configStamp = async (path: string): Promise<string> => {
    const info = await stat(path).catch(() => null)
    if (!info) {
      return `${path}:-`
    }
    const key = `${info.ino}:${info.mtimeMs}:${info.size}`
    const cached = configs.get(path)
    if (cached?.key === key) {
      return cached.digest
    }
    const text = await readFile(path, 'utf8').catch(() => '')
    let kept: string
    try {
      // Parsed, so headers, dotted keys and inline tables all count.
      const { skills, plugins } = parseToml(text)
      kept = JSON.stringify([skills ?? null, plugins ?? null])
    } catch {
      kept = text
    }
    const digest = `${path}:${createHash('sha1').update(kept).digest('hex')}`
    configs.set(path, { key, digest })
    return digest
  }

  return async (
    accountHomePath: string,
    cwd: string,
    signal: AbortSignal
  ): Promise<string | undefined> => {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(STAMP_TIMEOUT_MS)])
    const work = async (): Promise<string> => {
      // Orca's managed home holds copies the probe rewrites; stamping them would rescan forever.
      const mirrored =
        normalizeRuntimePathForComparison(accountHomePath) ===
        normalizeRuntimePathForComparison(managedCodexHome())
      const copiedFrom = mirrored
        ? await markers(accountHomePath, signal, () =>
            readCopiedResourceSource(accountHomePath, 'skills')
          )
        : null
      const skills = copiedFrom ?? join(accountHomePath, 'skills')
      const project = await chains(cwd, signal, (limit) => projectDirectories(cwd, limit))
      const sources = [
        skills,
        join(skills, '.system'),
        join(home(), '.agents', 'skills'),
        ...(process.platform === 'win32' ? [] : ['/etc/codex/skills']),
        ...project.flatMap((directory) => [
          join(directory, '.agents', 'skills'),
          join(directory, '.codex', 'skills')
        ])
      ]
      const parts: string[] = []
      // One root at a time: each walk already keeps up to three reads in flight.
      for (const root of sources) {
        parts.push(root, await rootStamp(root, signal))
      }
      // Trusted projects can enable plugins in their own config too.
      for (const config of new Set([
        ...(mirrored ? [] : [join(accountHomePath, 'config.toml')]),
        join(systemCodexHome(), 'config.toml'),
        ...project.map((directory) => join(directory, '.codex', 'config.toml'))
      ])) {
        parts.push(await configReads(config, signal, () => configStamp(config)))
      }
      return createHash('sha1').update(parts.join('\n')).digest('hex')
    }
    // Caps the menu's wait even while a joined root walk is still running.
    return waitForPromiseWithSignal(work(), bounded).catch(() => undefined)
  }
}

/** Codex reads project skills and config in each folder from the git root down to cwd. */
async function projectDirectories(cwd: string, signal: AbortSignal): Promise<string[]> {
  const chain: string[] = []
  for (let directory = cwd; ; directory = dirname(directory)) {
    signal.throwIfAborted()
    chain.push(directory)
    if (
      await stat(join(directory, '.git')).then(
        () => true,
        () => false
      )
    ) {
      break
    }
    if (dirname(directory) === directory) {
      chain.splice(1)
      break
    }
  }
  return chain
}
