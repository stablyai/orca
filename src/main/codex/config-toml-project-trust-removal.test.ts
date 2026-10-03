import { describe, expect, it } from 'vitest'
import { removeOrcaWrittenProjectTrustTables } from './config-toml-project-trust-removal'
import { upsertProjectTrustLevelInContent } from './config-toml-trust'

const removeAll = (): boolean => true

describe('removeOrcaWrittenProjectTrustTables', () => {
  it('undoes the table Orca appended, leaving the rest of the file as it was', () => {
    const original = 'model = "gpt-5"\n\n[features]\nhooks = true\n'
    const trusted = upsertProjectTrustLevelInContent(original, '/work/repo-r1', 'trusted', {
      alreadyCanonical: true
    })

    const result = removeOrcaWrittenProjectTrustTables(trusted, removeAll)

    expect(result).toEqual({ content: original, removedPaths: ['/work/repo-r1'] })
  })

  it('removes only the paths it is asked to, from the middle of the file', () => {
    const content = [
      '[projects."/work/a"]',
      'trust_level = "trusted"',
      '',
      '[projects."/work/b"]',
      'trust_level = "trusted"',
      '',
      '[features]',
      'hooks = true',
      ''
    ].join('\n')

    const result = removeOrcaWrittenProjectTrustTables(content, (path) => path === '/work/a')

    expect(result.removedPaths).toEqual(['/work/a'])
    expect(result.content).toBe(
      '[projects."/work/b"]\ntrust_level = "trusted"\n\n[features]\nhooks = true\n'
    )
  })

  it('keeps tables that someone changed after Orca wrote them', () => {
    const content = [
      '[projects."/work/untrusted"]',
      'trust_level = "untrusted"',
      '',
      '[projects."/work/extra-key"]',
      'trust_level = "trusted"',
      'sandbox_mode = "workspace-write"',
      '',
      "[projects.'/work/literal']",
      'trust_level = "trusted"',
      '',
      '[projects."/work/codex-spelling"]',
      '"trust_level" = "trusted"',
      ''
    ].join('\n')

    expect(removeOrcaWrittenProjectTrustTables(content, removeAll)).toEqual({
      content,
      removedPaths: []
    })
  })

  it('preserves CRLF line endings', () => {
    const content = 'a = 1\r\n\r\n[projects."C:\\\\work\\\\x"]\r\ntrust_level = "trusted"\r\n'

    const result = removeOrcaWrittenProjectTrustTables(content, removeAll)

    expect(result).toEqual({ content: 'a = 1\r\n', removedPaths: ['C:\\work\\x'] })
  })

  it('empties a file that held only Orca trust', () => {
    const content = '[projects."/work/a"]\ntrust_level = "trusted"\n'

    expect(removeOrcaWrittenProjectTrustTables(content, removeAll).content).toBe('')
  })
})
