import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetLspServerAvailabilityForTests,
  resolveLspServerForLanguage,
  toLspDocumentLanguageId
} from './lsp-server-catalog'

describe('toLspDocumentLanguageId', () => {
  it('maps react dialects by extension and passes everything else through', () => {
    expect(toLspDocumentLanguageId('typescript', '/a/App.tsx')).toBe('typescriptreact')
    expect(toLspDocumentLanguageId('typescript', '/a/app.ts')).toBe('typescript')
    expect(toLspDocumentLanguageId('javascript', '/a/App.JSX')).toBe('javascriptreact')
    expect(toLspDocumentLanguageId('python', '/a/x.py')).toBe('python')
  })
})

describe('resolveLspServerForLanguage', () => {
  beforeEach(() => resetLspServerAvailabilityForTests())

  it('prefers tsgo for typescript when installed', async () => {
    const resolved = await resolveLspServerForLanguage('typescript', () => Promise.resolve(true))
    expect(resolved?.serverId).toBe('tsgo')
    expect(resolved?.args).toEqual(['--lsp', '--stdio'])
  })

  it('falls back to typescript-language-server when tsgo is missing', async () => {
    const resolved = await resolveLspServerForLanguage('typescript', (command) =>
      Promise.resolve(command !== 'tsgo')
    )
    expect(resolved?.serverId).toBe('typescript-language-server')
  })

  it('returns null for unknown languages and when nothing is installed', async () => {
    expect(await resolveLspServerForLanguage('plaintext', () => Promise.resolve(true))).toBeNull()
    expect(await resolveLspServerForLanguage('go', () => Promise.resolve(false))).toBeNull()
  })

  it('caches probe verdicts per command', async () => {
    let probes = 0
    const probe = (): Promise<boolean> => {
      probes++
      return Promise.resolve(true)
    }
    await resolveLspServerForLanguage('typescript', probe)
    await resolveLspServerForLanguage('javascript', probe)
    expect(probes).toBe(1)
  })
})
