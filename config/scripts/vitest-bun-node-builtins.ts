import fs from 'node:fs'
import os from 'node:os'
import { vi } from 'vitest'

declare global {
  var orcaBunNodeAccessNormalized: boolean | undefined
}

if (process.versions.bun) {
  if (!globalThis.orcaBunNodeAccessNormalized) {
    const access = fs.promises.access
    // Bun resolves access() with null; Node's Promise<void> resolves with undefined.
    fs.promises.access = async (...args) => {
      await access(...args)
    }
    globalThis.orcaBunNodeAccessNormalized = true
  }

  // Child fixtures exercise the application's Node runtime, independently of Vitest's runtime.
  const nodeExecutable = process.env.ORCA_TEST_NODE_EXECUTABLE ?? process.env.npm_node_execpath
  if (nodeExecutable) {
    process.execPath = nodeExecutable
  }

  // Bun caches HOME and does not publish the write guard through syncBuiltinESMExports.
  const homedir = () =>
    (process.platform === 'win32' ? process.env.USERPROFILE : process.env.HOME) ?? os.homedir()

  vi.doMock('node:os', () => ({ ...os, homedir, default: { ...os, homedir } }))
  vi.doMock('node:fs', () => ({ ...fs, default: fs }))
  vi.doMock('node:fs/promises', () => ({ ...fs.promises, default: fs.promises }))
}
