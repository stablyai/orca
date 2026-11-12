import { afterEach, describe, expect, it, vi } from 'vitest'
import { JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY } from '../../shared/jira/jira-agent-capability'
import { JIRA_ISSUE_EDIT_FIELDS_RUNTIME_CAPABILITY } from '../../shared/jira/jira-detail-capabilities'
import { okFixture } from '../test-fixtures'
import { JIRA_HANDLERS } from './jira'

const site = {
  id: 'site-1',
  siteUrl: 'https://example.atlassian.net',
  email: 'test@example.com',
  displayName: 'Jira',
  accountId: 'user-1'
}
const editFields = [
  {
    key: 'customfield_10050',
    name: 'Acceptance criteria',
    required: false,
    schema: {
      type: 'string',
      custom: 'com.atlassian.jira.plugin.system.customfieldtypes:textarea'
    },
    operations: ['set'],
    value: { kind: 'text', text: 'Logs in\nRedirects home' },
    richText: true,
    writable: true,
    rawValue: { type: 'doc', version: 1, content: [] }
  },
  {
    key: 'customfield_10010',
    name: 'Sprint',
    required: false,
    schema: { type: 'array', items: 'json' },
    operations: [],
    value: { kind: 'unsupported', display: 'Sprint 7' },
    writable: false,
    rawValue: [{ id: 7, name: 'Sprint 7', state: 'active' }]
  }
]
const editFieldsHost = {
  capabilities: [JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY, JIRA_ISSUE_EDIT_FIELDS_RUNTIME_CAPABILITY]
}

function runtimeClient(host: { capabilities: string[] }) {
  const values: Record<string, unknown> = {
    'status.get': host,
    'jira.status': { connected: true, viewer: null, sites: [site], selectedSiteId: site.id },
    'jira.getIssueEditFields': editFields
  }
  return vi.fn(async (method: string) => okFixture('req-jira', values[method]))
}

async function listFields(key: string, call: ReturnType<typeof runtimeClient>, json: boolean) {
  await JIRA_HANDLERS['jira field list']({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the handler only calls client.call.
    client: { call } as never,
    cwd: '/tmp',
    flags: new Map([['key', key]]),
    json
  })
}

describe('jira field list', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads edit fields with their raw Jira values on the site an issue URL names', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const call = runtimeClient(editFieldsHost)
    await listFields(`${site.siteUrl}/browse/eng-123`, call, true)
    expect(call).toHaveBeenCalledWith('jira.getIssueEditFields', {
      key: 'ENG-123',
      siteId: site.id,
      strict: true,
      includeRaw: true
    })
    expect(JSON.parse(String(log.mock.calls.at(-1)?.[0]))).toMatchObject({ result: editFields })
  })

  it('prints one line per edit field without raw values', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    await listFields('ENG-123', runtimeClient(editFieldsHost), false)
    expect(log).toHaveBeenCalledWith(
      'customfield_10050\tAcceptance criteria\tLogs in…\ncustomfield_10010\tSprint\tSprint 7\t(read-only)'
    )
  })

  it('rejects hosts without edit-field reads before any Jira request', async () => {
    const call = runtimeClient({ capabilities: [JIRA_AGENT_ACCESS_RUNTIME_CAPABILITY] })
    await expect(listFields('ENG-123', call, true)).rejects.toMatchObject({
      code: 'incompatible_runtime'
    })
    expect(call.mock.calls).toEqual([['status.get']])
  })
})
