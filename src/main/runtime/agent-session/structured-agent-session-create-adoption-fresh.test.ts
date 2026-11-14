import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { CLAUDE_CLI_CONVERSATIONS } from '../../claude/claude-cli-conversations'
import { resolveStructuredAgentSessionAdoptionForCreateOrFresh } from './structured-agent-session-create-adoption-fresh'

it('starts a new chat when the resumed conversation has no saved transcript', async () => {
  const root = join(tmpdir(), 'orca-adoption-absence')
  const importer = CLAUDE_CLI_CONVERSATIONS.transcriptImport!
  const selectedAccountHome = { variable: 'CLAUDE_CONFIG_DIR', path: root }
  vi.spyOn(importer, 'accountHomeCandidates').mockReturnValue([selectedAccountHome])
  const find = vi.spyOn(importer, 'findTranscript').mockResolvedValue(null)
  const input = {
    settings: {},
    agent: 'claude' as const,
    transcriptImport: importer,
    providerSessionId: '0197d0c0-ffee-7000-8000-000000000000',
    selectedAccountHome,
    launchEnv: {},
    workspaceCwd: root
  }
  expect(await resolveStructuredAgentSessionAdoptionForCreateOrFresh(input)).toBeNull()
  expect(find).toHaveBeenCalled()
  find.mockRejectedValueOnce(Object.assign(new Error('projects unreadable'), { code: 'EACCES' }))
  await expect(resolveStructuredAgentSessionAdoptionForCreateOrFresh(input)).rejects.toMatchObject({
    refusal: { details: { reason: 'transcriptUnreadable' } }
  })
})
