import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  darwinTerminalNodeInputs,
  readBuiltDarwinTerminalNode
} from './build-darwin-terminal-node.mjs'

const directories = []
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function artifact() {
  const directory = mkdtempSync(join(tmpdir(), 'darwin-terminal-node-cache-'))
  directories.push(directory)
  const inputs = darwinTerminalNodeInputs('arm64')
  const bytes = Buffer.from('built Node artifact')
  const executable = join(directory, 'node')
  writeFileSync(executable, bytes)
  writeFileSync(
    join(directory, 'receipt.json'),
    JSON.stringify({
      inputs,
      executableSha256: createHash('sha256').update(bytes).digest('hex')
    })
  )
  return { directory, inputs, executable }
}

it('requires review when the Node pin moves instead of silently dropping the fix', () => {
  expect(() => darwinTerminalNodeInputs('arm64', '99.0.0')).toThrow('Review the Darwin')
  expect(() => darwinTerminalNodeInputs('riscv64')).toThrow('Unsupported')
})

it('separates architecture and includes the exact patch and source identity', () => {
  const arm = darwinTerminalNodeInputs('arm64')
  const x64 = darwinTerminalNodeInputs('x64')
  expect(arm.arch).not.toBe(x64.arch)
  expect(arm.sourceSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(arm.workerSourceSha256).toMatch(/^[0-9a-f]{64}$/)
  expect(arm.patchSha256).toBe(
    createHash('sha256')
      .update(
        readFileSync(join(import.meta.dirname, '../node-runtime-patches/darwin-worker-wait.patch'))
      )
      .digest('hex')
  )
})

it('reuses a built artifact only when its bytes and every build input match', async () => {
  const { directory, inputs, executable } = artifact()
  expect(await readBuiltDarwinTerminalNode(directory, inputs)).toBe(executable)
  expect(await readBuiltDarwinTerminalNode(directory, { ...inputs, arch: 'x64' })).toBeNull()
  expect(
    await readBuiltDarwinTerminalNode(directory, { ...inputs, patchSha256: 'other' })
  ).toBeNull()
})

it('rejects a tampered cached executable', async () => {
  const { directory, inputs, executable } = artifact()
  writeFileSync(executable, 'different bytes')
  expect(await readBuiltDarwinTerminalNode(directory, inputs)).toBeNull()
})

it('rejects unchanged executable bytes built with an older build script', async () => {
  const { directory, inputs, executable } = artifact()
  const receiptPath = join(directory, 'receipt.json')
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'))
  expect(inputs.buildScriptsSha256['build-darwin-terminal-node.mjs']).toMatch(/^[0-9a-f]{64}$/)
  expect(await readBuiltDarwinTerminalNode(directory, inputs)).toBe(executable)
  receipt.inputs.buildScriptsSha256['build-darwin-terminal-node.mjs'] = 'older build recipe'
  writeFileSync(receiptPath, JSON.stringify(receipt))
  expect(await readBuiltDarwinTerminalNode(directory, inputs)).toBeNull()
  delete receipt.inputs.buildScriptsSha256
  writeFileSync(receiptPath, JSON.stringify(receipt))
  expect(await readBuiltDarwinTerminalNode(directory, inputs)).toBeNull()
})

it('rejects a partial build, invalid receipt, or non-file executable', async () => {
  const { directory, inputs, executable } = artifact()
  rmSync(executable)
  expect(await readBuiltDarwinTerminalNode(directory, inputs)).toBeNull()
  mkdirSync(executable)
  expect(await readBuiltDarwinTerminalNode(directory, inputs)).toBeNull()
  writeFileSync(join(directory, 'receipt.json'), '{')
  expect(await readBuiltDarwinTerminalNode(directory, inputs)).toBeNull()
})
