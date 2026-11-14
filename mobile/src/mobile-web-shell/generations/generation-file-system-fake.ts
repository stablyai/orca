import type { GenerationFileSystem } from './generation-store-file-system'

// Share the adapter’s move/failure semantics across store suites so their in-memory disks cannot disagree.
export const FAKE_GENERATION_ROOT = 'file:///cache/mobile-web'

type FakeNode = { kind: 'directory' } | { kind: 'file'; bytes: Uint8Array; modifiedAt?: number }

export type FakeGenerationFileSystem = GenerationFileSystem & {
  readonly writes: string[]
  paths(): readonly string[]
  seed(path: string, node: FakeNode): void
  failWritesAt(path: string | null): void
  failReadsAt(path: string | null): void
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
  let moveKeepsContents = true
  const uri = (path: string): string => `${ROOT}/${path}`
  const parentOf = (target: string): string => target.slice(0, target.lastIndexOf('/'))

  const makeDirectory = (target: string): void => {
    // Any file:// tree, so a store can also be handed an older root on the same disk.
    for (let at = target; at.startsWith('file:///'); at = parentOf(at)) {
      nodes.set(at, { kind: 'directory' })
    }
  }
  const write = (target: string, bytes: Uint8Array): void => {
    if (failAt !== null && target === uri(failAt)) {
      throw new Error('simulated disk-full write')
    }
    makeDirectory(parentOf(target))
    nodes.set(target, { kind: 'file', bytes, modifiedAt: Date.now() })
    writes.push(target.slice(ROOT.length + 1))
  }

  return {
    rootUri: ROOT,
    writes,
    paths: () =>
      [...nodes.keys()]
        .filter((key) => key.startsWith(`${ROOT}/`))
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
    async readBytes(target) {
      if (failReadAt !== null && target === uri(failReadAt)) {
        throw new Error('simulated unreadable file')
      }
      const node = nodes.get(target)
      return node?.kind === 'file' ? node.bytes : null
    },
    async fileExists(target) {
      return nodes.get(target)?.kind === 'file'
    },
    async fileSize(target) {
      const node = nodes.get(target)
      return node?.kind === 'file' ? node.bytes.byteLength : null
    },
    async listFiles(target) {
      if (nodes.get(target)?.kind !== 'directory') {
        return []
      }
      return [...nodes.entries()].flatMap(([key, node]) =>
        node.kind === 'file' &&
        key.startsWith(`${target}/`) &&
        !key.slice(target.length + 1).includes('/')
          ? [
              {
                name: key.slice(target.length + 1),
                size: node.bytes.byteLength,
                modificationTime: node.modifiedAt ?? null
              }
            ]
          : []
      )
    },
    async summarizeDirectory(target) {
      let size = 0
      let entryCount = 0
      for (const [key, node] of nodes.entries()) {
        if (!key.startsWith(`${target}/`)) {
          continue
        }
        if (!key.slice(target.length + 1).includes('/')) {
          entryCount += 1
        }
        if (node.kind === 'file') {
          size += node.bytes.byteLength
        }
      }
      return { size, entryCount }
    },
    async copyFile(fromUri, toUri) {
      if (failReadAt !== null && fromUri === uri(failReadAt)) {
        throw new Error('simulated unreadable file')
      }
      const node = nodes.get(fromUri)
      if (node?.kind !== 'file') {
        throw new Error(`fake filesystem has no file at ${fromUri}`)
      }
      if (nodes.has(toUri)) {
        throw new Error(`fake filesystem refuses to copy onto ${toUri}`)
      }
      write(toUri, node.bytes)
    },
    async delete(target) {
      for (const key of Array.from(nodes.keys())) {
        if (key === target || key.startsWith(`${target}/`)) {
          nodes.delete(key)
        }
      }
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
    },
    async moveFile(fromUri, toUri) {
      const node = nodes.get(fromUri)
      if (node?.kind !== 'file') {
        throw new Error(`fake filesystem has no file at ${fromUri}`)
      }
      if (nodes.has(toUri)) {
        throw new Error(`fake filesystem refuses to move onto ${toUri}`)
      }
      nodes.delete(fromUri)
      makeDirectory(parentOf(toUri))
      nodes.set(toUri, node)
    }
  }
}
