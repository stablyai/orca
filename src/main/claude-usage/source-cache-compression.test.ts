import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync, gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { sealUsageCacheJson, verifyUsageCacheJson } from '../usage/cache/usage-cache-json-integrity'
import { readClaudeUsageJson, writeClaudeUsageJson } from './source-cache-compression'

let directory: string
const domain = 'claude-usage-sources-v1'
const source = {
  schemaVersion: 7,
  sources: [{ path: `${'a'.repeat(4095)}😀é\ud800`, ownedDedupeKeys: ['日本語 🌊'.repeat(10_000)] }]
}
const ref = () => ({
  path: join(directory, 'sources.json'),
  schemaVersion: 7,
  worktreeFingerprint: null,
  reuse: true
})
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-claude-stream-'))
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it('cross-reads existing protected plain and gzip text and emits the same verified material', async () => {
  const original = sealUsageCacheJson(JSON.stringify(source), domain)
  for (const saved of [Buffer.from(original), gzipSync(original)]) {
    await writeFile(ref().path, saved)
    const loaded = await readClaudeUsageJson(ref().path, domain)
    expect(loaded.verified).toBe(true)
    expect(loaded.parsed).toMatchObject(source)
  }
  await writeClaudeUsageJson(ref(), source, domain, true)
  const saved = await readFile(ref().path)
  const text = saved[0] === 0x1f ? gunzipSync(saved).toString('utf8') : saved.toString('utf8')
  const parsed = JSON.parse(text)
  expect(verifyUsageCacheJson(text, parsed.usageIntegrity, domain)).toBe(true)
  expect(parsed.sources).toEqual(source.sources)
  expect((await readClaudeUsageJson(ref().path, domain)).parsed).toEqual(parsed)
})

it('rejects corruption and partial generations before returning sources', async () => {
  const original = sealUsageCacheJson(JSON.stringify(source), domain)
  const gzip = gzipSync(original)
  const forged = Buffer.from(gzip)
  forged.writeUInt32LE(70_000, forged.length - 4)
  for (const saved of [
    Buffer.from(original.replace('日本語', '日木語')),
    Buffer.from(`${original} null`),
    gzip.subarray(0, -7),
    forged,
    Buffer.concat([gzip, gzip])
  ]) {
    await writeFile(ref().path, saved)
    await expect(readClaudeUsageJson(ref().path, domain)).rejects.toThrow()
  }
})

it('removes only its staging file when compressed publication fails', async () => {
  const { mkdir } = await import('node:fs/promises')
  await mkdir(ref().path)
  await expect(writeClaudeUsageJson(ref(), source, domain, true)).rejects.toThrow()
  expect(await readdir(directory)).toEqual(['sources.json'])
})
