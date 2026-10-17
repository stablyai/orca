import { describe, expect, it } from 'vitest'
import {
  agentHistoryHostStatusSchema,
  agentHistorySessionScanSchema,
  resumeMetadataListSchema,
  resumeRepoListSchema
} from './agent-history-reply-schema'

describe('agent history reply schemas', () => {
  it('reads an unreadable capability list as a host that does not advertise the vault', () => {
    expect(agentHistoryHostStatusSchema.parse({}).capabilities).toBeUndefined()
    expect(agentHistoryHostStatusSchema.parse({ capabilities: 'all' }).capabilities).toBeUndefined()
    expect(agentHistoryHostStatusSchema.parse({ capabilities: ['x'] }).capabilities).toEqual(['x'])
  })

  it('passes the rest of the status record through for the platform readers', () => {
    expect(
      agentHistoryHostStatusSchema.parse({ capabilities: [], platform: 'win32' })
    ).toMatchObject({ platform: 'win32' })
  })

  it('requires both scan containers the ready screen publishes', () => {
    expect(agentHistorySessionScanSchema.safeParse({ sessions: [] }).success).toBe(false)
    expect(agentHistorySessionScanSchema.safeParse({ issues: [] }).success).toBe(false)
    expect(agentHistorySessionScanSchema.safeParse({ sessions: 'none', issues: [] }).success).toBe(
      false
    )
    expect(agentHistorySessionScanSchema.safeParse({ sessions: [], issues: [] }).success).toBe(true)
  })

  it('keeps a session row whose agent this build has never heard of', () => {
    // The agent vocabulary grows with every CLI Orca learns to scan and is echoed back on resume,
    // so a newer host's rows must survive rather than being refused or dropped.
    const parsed = agentHistorySessionScanSchema.parse({
      sessions: [{ id: 's1', agent: 'some-new-agent' }],
      issues: []
    })
    expect(parsed.sessions).toEqual([{ id: 's1', agent: 'some-new-agent' }])
  })

  it('reads conditional fingerprint and unchanged without requiring them', () => {
    expect(
      agentHistorySessionScanSchema.parse({ sessions: [], issues: [] })
    ).toMatchObject({ sessions: [], issues: [] })
    const conditional = agentHistorySessionScanSchema.parse({
      sessions: [],
      issues: [],
      fingerprint: 'a'.repeat(64),
      unchanged: true
    })
    expect(conditional.fingerprint).toBe('a'.repeat(64))
    expect(conditional.unchanged).toBe(true)
  })

  it('salvages a non-string fingerprint instead of refusing the scan', () => {
    const parsed = agentHistorySessionScanSchema.parse({
      sessions: [{ id: 's1' }],
      issues: [],
      fingerprint: 12,
      unchanged: 'yes'
    })
    expect(parsed.sessions).toEqual([{ id: 's1' }])
    expect(parsed.fingerprint).toBeUndefined()
    expect(parsed.unchanged).toBeUndefined()
  })

  it('requires the resume repo list to be an array', () => {
    expect(resumeRepoListSchema.safeParse({}).success).toBe(false)
    expect(resumeRepoListSchema.safeParse({ repos: 'none' }).success).toBe(false)
    expect(resumeRepoListSchema.parse({ repos: [{ id: 'r' }] }).repos).toEqual([{ id: 'r' }])
  })

  it('accepts any resume metadata object and refuses a payload that is not one', () => {
    expect(resumeMetadataListSchema.parse({ folderWorkspaces: [] })).toMatchObject({
      folderWorkspaces: []
    })
    expect(resumeMetadataListSchema.safeParse('none').success).toBe(false)
    expect(resumeMetadataListSchema.safeParse(null).success).toBe(false)
  })
})
