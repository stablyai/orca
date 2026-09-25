import type { GenerationFileSystem } from './generation-store-file-system'

/**
 * The generation store's disk, in memory: the port it is written against, plus the faults a cache
 * really takes.
 *
 * Shared rather than copied because more than one suite drives the real store against it, and two
 * in-memory trees answering the same port differently is how a passing suite stops being evidence
 * about the adapter. The write ordering, the interruption windows and the move semantics are the
 * adapter's own; each is commented where it differs from the obvious thing.
 */
export const FAKE_GENERATION_ROOT = 'file:///cache/mobile-web'

type FakeNode = { kind: 'directory' } | { kind: 'file'; bytes: Uint8Array }

export type FakeGenerationFileSystem = GenerationFileSystem & {
  readonly writes: string[]
  paths(): readonly string[]
  seed(path: string, node: FakeNode): void
  failWritesAt(path: string | null): void
  failReadsAt(path: string | null): void
  failDeletesAt(path: string | null): void
  failFileMovesTo(path: string | null): void
  loseContentsOnMove(): void
  text(path: string): string | null
  bytes(path: string): Uint8Array | null
}

export function createFakeGenerationFileSystem(): FakeGenerationFileSystem {
  const ROOT = FAKE_GENERATION_ROOT
  const nodes = new Map<string, FakeNode>()
  const writes: string[] = []
  let failAt: string | null = null
  let failReadAt: string | null = null
  let failDeleteAt: string | null = null
  let failMoveTo: string | null = null
  let moveKeepsContents = true
  const uri = (path: string): string => `${ROOT}/${path}`
  const parentOf = (target: string): string => target.slice(0, target.lastIndexOf('/'))

  const makeDirectory = (target: string): void => {
    for (let at = target; at.startsWith(ROOT); at = parentOf(at)) {
      nodes.set(at, { kind: 'directory' })
    }
  }
  const write = (target: string, bytes: Uint8Array): void => {
    if (failAt !== null && target === uri(failAt)) {
      throw new Error('simulated disk-full write')
    }
    makeDirectory(parentOf(target))
    nodes.set(target, { kind: 'file', bytes })
    writes.push(target.slice(ROOT.length + 1))
  }

  return {
    rootUri: ROOT,
    writes,
    paths: () =>
      [...nodes.keys()]
        .filter((key) => key !== ROOT)
        .map((key) => key.slice(ROOT.length + 1))
        .sort(),
    seed: (path, node) => {
      makeDirectory(parentOf(uri(path)))
      nodes.set(uri(path), node)
    },
    failWritesAt: (path) => {
      failAt = path
    },
    failReadsAt: (path) => {
      failReadAt = path
    },
    failDeletesAt: (path) => {
      failDeleteAt = path
    },
    failFileMovesTo: (path) => {
      failMoveTo = path
    },
    loseContentsOnMove: () => {
      moveKeepsContents = false
    },
    text: (path) => {
      const node = nodes.get(uri(path))
      return node?.kind === 'file' ? new TextDecoder().decode(node.bytes) : null
    },
    bytes: (path) => {
      const node = nodes.get(uri(path))
      return node?.kind === 'file' ? node.bytes : null
    },
    async list(target) {
      if (nodes.get(target)?.kind !== 'directory') {
        return []
      }
      return [...nodes.entries()]
        .filter(
          ([key]) => key.startsWith(`${target}/`) && !key.slice(target.length + 1).includes('/')
        )
        .map(([key, node]) => ({
          name: key.slice(target.length + 1),
          isDirectory: node.kind === 'directory'
        }))
    },
    async createDirectory(target) {
      makeDirectory(target)
    },
    async writeBytes(target, bytes) {
      write(target, bytes)
    },
    async writeText(target, value) {
      write(target, new TextEncoder().encode(value))
    },
    async readText(target) {
      if (failReadAt !== null && target === uri(failReadAt)) {
        throw new Error('simulated unreadable file')
      }
      const node = nodes.get(target)
      return node?.kind === 'file' ? new TextDecoder().decode(node.bytes) : null
    },
    async fileExists(target) {
      return nodes.get(target)?.kind === 'file'
    },
    async delete(target) {
      if (failDeleteAt !== null && target === uri(failDeleteAt)) {
        throw new Error('simulated undeletable file')
      }
      for (const key of Array.from(nodes.keys())) {
        if (key === target || key.startsWith(`${target}/`)) {
          nodes.delete(key)
        }
      }
    },
    async moveFile(fromUri, toUri) {
      // The adapter's own ordering, and the worst case of it: expo refuses a destination that
      // exists, so the destination goes first and the failure is injected after it. A fake that
      // threw before that delete would never exercise the window the adapter really leaves.
      const node = nodes.get(fromUri)
      if (node?.kind !== 'file') {
        throw new Error(`fake filesystem has no file at ${fromUri}`)
      }
      nodes.delete(toUri)
      if (failMoveTo !== null && toUri === uri(failMoveTo)) {
        throw new Error('simulated interrupted rename')
      }
      nodes.delete(fromUri)
      nodes.set(toUri, node)
    },
    async moveDirectory(fromUri, toUri) {
      if (nodes.has(toUri)) {
        throw new Error(`fake filesystem refuses to move onto ${toUri}`)
      }
      for (const [key, node] of Array.from(nodes.entries())) {
        if (key === fromUri || key.startsWith(`${fromUri}/`)) {
          nodes.delete(key)
          if (moveKeepsContents || key === fromUri) {
            nodes.set(toUri + key.slice(fromUri.length), node)
          }
        }
      }
    }
  }
}
