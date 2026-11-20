import { describe, expect, it } from 'vitest'
import { normalizeJiraIssueUpdate } from './ipc-params'

describe('Jira IPC parameters', () => {
  it('preserves edit-screen fields and their shaping keys', () => {
    const updates = {
      fields: { customfield_10050: 'Logs in', customfield_10060: null },
      userFieldKeys: ['customfield_10070'],
      richTextFieldKeys: ['customfield_10050']
    }
    expect(normalizeJiraIssueUpdate(updates)).toEqual(updates)
  })

  it.each([
    { fields: [] },
    { fields: null },
    { userFieldKeys: 'customfield_10070' },
    { richTextFieldKeys: [1] }
  ])('rejects malformed edit-screen fields before they reach Jira: %j', (value) => {
    expect(normalizeJiraIssueUpdate(value)).toBeNull()
  })
})
