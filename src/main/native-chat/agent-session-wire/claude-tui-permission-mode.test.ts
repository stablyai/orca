import { appendFile, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import {
  readClaudeTuiPermissionMode,
  resolveClaudeNativeHandoffOptions
} from './claude-tui-permission-mode'
import { readNativeSessionOptionRestoration } from './structured-agent-session-option-restoration'

const SESSION_ID = '74457f86-185a-4cc9-9b9a-1f00fb736d2f'
let root: string | null = null

afterEach(async () => {
  if (root) {
    await rm(root, { recursive: true, force: true })
  }
  root = null
})

async function transcript(lines: readonly unknown[]): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'orca-claude-permission-mode-'))
  const filePath = join(root, `${SESSION_ID}.jsonl`)
  await writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
  return filePath
}

describe('Claude TUI permission mode', () => {
  it('reconciles a durable Plan override even when an older record lacks its baseline', () => {
    expect(
      resolveClaudeNativeHandoffOptions(
        { provider: 'claude', options: { permissionMode: 'plan' } },
        { model: 'claude-sonnet', permissionMode: 'plan' }
      )
    ).toEqual({
      options: { model: 'claude-sonnet' },
      permissionModeAdoption: 'required'
    })
  })

  it('reads the final valid mode for the expected provider session', async () => {
    const filePath = await transcript([
      { type: 'permission-mode', permissionMode: 'default', sessionId: SESSION_ID },
      { type: 'permission-mode', permissionMode: 'plan', sessionId: 'other-session' },
      { type: 'permission-mode', permissionMode: 'retired-mode', sessionId: SESSION_ID },
      { type: 'assistant', message: { content: [] }, sessionId: SESSION_ID },
      { type: 'permission-mode', permissionMode: 'plan', sessionId: SESSION_ID }
    ])

    await expect(
      readClaudeTuiPermissionMode({ filePath, providerSessionId: SESSION_ID })
    ).resolves.toBe('plan')
  })

  it('returns unavailable when the transcript has no exact-session mode proof', async () => {
    const filePath = await transcript([
      { type: 'permission-mode', permissionMode: 'plan', sessionId: 'other-session' },
      { type: 'permission-mode', permissionMode: 'retired-mode', sessionId: SESSION_ID }
    ])

    await expect(
      readClaudeTuiPermissionMode({ filePath, providerSessionId: SESSION_ID })
    ).resolves.toBeNull()
    await expect(
      readClaudeTuiPermissionMode({
        filePath: join(root!, 'missing.jsonl'),
        providerSessionId: SESSION_ID
      })
    ).resolves.toBeNull()
  })

  it('does not revive an older mode after an exact-session unknown mode', async () => {
    const filePath = await transcript([
      { type: 'permission-mode', permissionMode: 'plan', sessionId: SESSION_ID },
      { type: 'permission-mode', permissionMode: 'future-mode', sessionId: SESSION_ID }
    ])

    await expect(
      readClaudeTuiPermissionMode({ filePath, providerSessionId: SESSION_ID })
    ).resolves.toBeNull()
  })

  it('reads the newest mode from the bounded tail of a large transcript', async () => {
    const filePath = await transcript([])
    await truncate(filePath, 20 * 1024 * 1024)
    await appendFile(
      filePath,
      `\n${JSON.stringify({
        type: 'permission-mode',
        permissionMode: 'plan',
        sessionId: SESSION_ID
      })}\n`,
      'utf8'
    )

    await expect(
      readClaudeTuiPermissionMode({ filePath, providerSessionId: SESSION_ID })
    ).resolves.toBe('plan')
  })

  it('strips permission mode from native resume arguments', () => {
    expect(
      resolveClaudeNativeHandoffOptions(
        { provider: 'claude' },
        { model: 'claude-sonnet', permissionMode: 'plan' }
      )
    ).toEqual({
      options: { model: 'claude-sonnet' },
      permissionModeAdoption: 'if-confirmed'
    })
  })

  it('refuses fallback reconciliation without a provider mode report', async () => {
    const adapter: Pick<
      StructuredAgentSessionAdapter,
      'readOptions' | 'readOptionRestoreFailures'
    > = {
      readOptions: async () => ({
        models: [],
        current: { model: 'claude-sonnet', confirmed: ['model'] }
      })
    }

    await expect(
      readNativeSessionOptionRestoration({
        adapter,
        sessionId: SESSION_ID,
        fence: 3,
        priorOptions: {},
        permissionModeAdoption: 'required'
      })
    ).rejects.toThrow('did not report its current permission mode')
    await expect(
      readNativeSessionOptionRestoration({
        adapter: {},
        sessionId: SESSION_ID,
        fence: 3,
        priorOptions: {},
        permissionModeAdoption: 'required'
      })
    ).rejects.toThrow('did not report its current permission mode')
  })

  it('keeps a pre-baseline handoff usable when an old provider cannot report mode', async () => {
    const adapter: Pick<
      StructuredAgentSessionAdapter,
      'readOptions' | 'readOptionRestoreFailures'
    > = {
      readOptions: async () => ({
        models: [],
        current: { model: 'claude-sonnet', confirmed: ['model'] }
      })
    }

    await expect(
      readNativeSessionOptionRestoration({
        adapter,
        sessionId: SESSION_ID,
        fence: 3,
        priorOptions: {},
        permissionModeAdoption: 'if-confirmed'
      })
    ).resolves.toEqual({ options: { model: 'claude-sonnet' } })
  })
})
