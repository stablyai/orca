import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { agyServesOrcaHome } from './antigravity-agy-orca-home'

let root = ''
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  root = ''
})

function agy(name: string): string {
  root ||= mkdtempSync(join(tmpdir(), 'agy-version-'))
  const path = join(root, name)
  writeFileSync(path, name)
  return path
}

it("takes agy 1.5.5 and newer on Orca's home, reading each binary's version once", async () => {
  const read = vi.fn(async ({ program }: { program: string }) => ({
    version: program.endsWith('new') ? '1.5.13' : program.endsWith('floor') ? '1.5.5' : '1.5.4'
  }))
  expect(await agyServesOrcaHome(agy('new'), {}, read)).toBe(true)
  expect(await agyServesOrcaHome(agy('floor'), {}, read)).toBe(true)
  expect(await agyServesOrcaHome(agy('old'), {}, read)).toBe(false)
  expect(await agyServesOrcaHome(join(root, 'new'), {}, read)).toBe(true)
  expect(read).toHaveBeenCalledTimes(3)
})

it("keeps chats on the server when agy's version can't be read", async () => {
  const unreadable = vi.fn(async () => ({ version: null }))
  expect(await agyServesOrcaHome(agy('silent'), {}, unreadable)).toBe(false)
  expect(await agyServesOrcaHome(join(root, 'missing'), {}, unreadable)).toBe(false)
})
