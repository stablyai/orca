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
  it('lets only an opted-in bot create, up to its cap per 24 hours, across restarts', () => {
    const file = store()
    const teams = file.make()
    const day = 24 * 60 * 60 * 1000
    expect(teams.mayCreate('lead', 1000)).toBe(false)
    teams.set('lead', { teamBuilder: true, dailyCap: 2 })
    teams.recordCreated('lead', 1000)
    teams.recordCreated('lead', 2000)
    const reopened = file.make()
    expect(reopened.mayCreate('lead', 3000)).toBe(false)
    expect(reopened.mayCreate('lead', 1000 + day)).toBe(true)
    expect(reopened.mayCreate('other', 3000)).toBe(false)
  })
})
