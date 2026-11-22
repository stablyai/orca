import { mkdtemp, mkdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { filterAiVaultSessions } from '../../../../shared/ai-vault/session-display/ai-vault-session-filters'
import { isAiVaultSessionResumableContent } from '../../../../shared/ai-vault/contracts/ai-vault-types'
import { validateAiVaultSessionDeleteTarget } from '../../deletion/session-delete-target'
import { parseAiVaultListResult } from '../../listing/session-list-result-validation'
import { scanCursorAcpMetadata } from './session-scanner-cursor-acp-metadata'

it('lists only bounded Cursor ACP metadata in its recorded workspace without enabling transcript actions', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'orca-cursor-history-'))
  try {
    const root = join(temp, 'acp-sessions')
    const workspace = join(temp, 'synthetic-project')
    const otherWorkspace = join(temp, 'other-project')
    const primary = join(root, 'acp-example', 'meta.json')
    const metadata = JSON.stringify({ cwd: workspace, title: 'Cursor example' })
    await mkdir(join(root, 'acp-example'), { recursive: true })
    await writeFile(primary, metadata)
    await writeFile(join(root, 'acp-example', 'store.db'), 'unused synthetic bytes')
    await utimes(primary, new Date(0), new Date(0))
    const fixtures = [
      ['acp-newer', JSON.stringify({ cwd: otherWorkspace, title: 'Other Cursor example' })],
      ['broken', '{'],
      ['oversized', metadata + ' '.repeat(64 * 1024)],
      ['relpath', JSON.stringify({ cwd: 'not/absolute', title: 'Do not list' })],
      ['nested/deeper', metadata],
      ['linked', null]
    ] as const
    for (const [name, contents] of fixtures) {
      await mkdir(join(root, name), { recursive: true })
      if (contents !== null) {
        await writeFile(join(root, name, 'meta.json'), contents)
      }
    }
    if (process.platform !== 'win32') {
      // File and directory symlinks are not provider-owned records, even if the body looks valid.
      await writeFile(join(temp, 'not-a-session.json'), metadata)
      await symlink(join(temp, 'not-a-session.json'), join(root, 'linked', 'meta.json'))
      await symlink(join(root, 'acp-example'), join(root, 'aliased-directory'))
    }

    const all = parseAiVaultListResult(await scanCursorAcpMetadata(root))
    expect(all.sessions.map((row) => row.sessionId).sort()).toEqual(['acp-example', 'acp-newer'])
    const scoped = parseAiVaultListResult(
      await scanCursorAcpMetadata(root, { scopeOnly: true, scopePaths: [workspace], limit: 1 })
    )
    expect(scoped.sessions).toHaveLength(1)
    const row = scoped.sessions[0]
    expect(row).toMatchObject({
      agent: 'cursor',
      cwd: workspace,
      sessionId: 'acp-example',
      historySource: 'cursor-acp-metadata',
      title: 'Cursor example',
      filePath: 'cursor-acp#acp-example',
      resumeCommand: '',
      messageCount: 0,
      previewMessages: []
    })
    expect(isAiVaultSessionResumableContent(row)).toBe(false)
    expect(
      validateAiVaultSessionDeleteTarget({
        agent: row.agent,
        executionHostId: row.executionHostId,
        filePath: row.filePath
      })
    ).toMatchObject({ allowed: false, reason: 'synthetic-path' })
    expect(
      filterAiVaultSessions(scoped.sessions, {
        agents: ['cursor'],
        scope: 'workspace',
        activeWorktreePaths: [workspace],
        hideEmptySessions: true,
        query: '',
        sort: 'updated'
      })
    ).toEqual([row])

    await writeFile(primary, JSON.stringify({ cwd: workspace, title: 'Renamed Cursor example' }))
    expect(
      (
        await scanCursorAcpMetadata(root, { scopeOnly: true, scopePaths: [workspace] })
      ).sessions.map((session) => session.title)
    ).toEqual(['Renamed Cursor example'])
    await rm(primary)
    expect(
      (await scanCursorAcpMetadata(root, { scopeOnly: true, scopePaths: [workspace] })).sessions
    ).toEqual([])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})
