import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentTeamStore } from './agent-team-store'

const dirs: string[] = []
function store(): { make: () => AgentTeamStore } {
  const dir = mkdtempSync(join(tmpdir(), 'agent-teams-'))
  dirs.push(dir)
  const path = join(dir, 'teams.json')
  return { make: () => new AgentTeamStore(() => path) }
}

afterEach(() => {
  dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true }))
})

describe('AgentTeamStore', () => {
  it('lets only an opted-in bot create, up to its cap per 24 hours, across restarts', async () => {
    const file = store()
    const teams = file.make()
    const day = 24 * 60 * 60 * 1000
    expect(await teams.mayCreate('lead', 1000)).toBe(false)
    await teams.set('lead', { teamBuilder: true, dailyCap: 2 })
    await teams.recordCreated('lead', 1000)
    await teams.recordCreated('lead', 2000)
    const reopened = file.make()
    expect(await reopened.mayCreate('lead', 3000)).toBe(false)
    expect(await reopened.mayCreate('lead', 1000 + day)).toBe(true)
    expect(await reopened.mayCreate('other', 3000)).toBe(false)
  })
})
