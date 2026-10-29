import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createAgentHookMemorySftp } from '../agent-hooks/agent-hook-memory-sftp.test-fixture'
import { ClaudeHookService } from './hook-service'

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

it('keeps local hooks installed when the optional mod cannot be written', () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-agent-view-hook-install-'))
  roots.push(root)
  vi.stubEnv('HOME', root)
  vi.stubEnv('USERPROFILE', root)
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  mkdirSync(join(root, '.claude'))
  writeFileSync(join(root, '.claude', 'skills'), 'blocked')

  const status = new ClaudeHookService().install({ claudeVersion: '2.1.309' })

  expect(status).toMatchObject({ state: 'installed', managedHooksPresent: true, detail: null })
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'))
  expect(settings.hooks.Stop).toHaveLength(1)
  expect(readFileSync(join(root, '.claude', 'skills'), 'utf8')).toBe('blocked')
})

it('keeps remote hooks installed when optional mod discovery fails', async () => {
  const memory = createAgentHookMemorySftp()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(memory.sftp, 'readdir').mockImplementation(() => {
    throw new Error('SFTP directory access denied')
  })

  const status = await new ClaudeHookService().installRemote(memory.sftp, '/home/remote', {
    claudeVersion: '2.1.309'
  })

  expect(status).toMatchObject({ state: 'installed', managedHooksPresent: true, detail: null })
  const settings = JSON.parse(memory.fs.files.get('/home/remote/.claude/settings.json') ?? '{}')
  expect(settings.hooks.Stop).toHaveLength(1)
})
