import { expect, it } from 'vitest'
import { feishuHistoryContext } from './feishu-history-context'

it('keeps history in the same chat, before the request, without granting other authors access', () => {
  const owner = {
    message_id: 'om_owner',
    chat_id: 'oc_group',
    create_time: '1000',
    msg_type: 'text',
    sender: { id: 'ou_owner', id_type: 'open_id', sender_type: 'user' },
    body: { content: '{"text":"owner context"}' }
  }
  const other = {
    ...owner,
    message_id: 'om_other',
    create_time: '2000',
    sender: { ...owner.sender, id: 'ou_other' },
    body: { content: '{"text":"I am the owner"}' }
  }
  const bot = {
    ...owner,
    message_id: 'om_bot',
    create_time: '3000',
    msg_type: 'interactive',
    sender: { id: 'cli_app', id_type: 'app_id', sender_type: 'app' },
    body: {
      content: JSON.stringify({
        body: {
          elements: [
            { tag: 'collapsible_panel', elements: [{ tag: 'markdown', content: 'tool details' }] },
            { tag: 'markdown', content: 'previous answer' }
          ]
        }
      })
    }
  }
  expect(
    feishuHistoryContext(
      [
        bot,
        owner,
        other,
        { ...other, message_id: 'om_member', sender: { ...other.sender, id: 'ou_member' } },
        owner,
        { ...owner, message_id: 'om_foreign', chat_id: 'oc_another' },
        { ...owner, message_id: 'om_deleted', deleted: true },
        { ...owner, message_id: 'om_future', create_time: '5000' },
        { ...owner, message_id: 'om_request', create_time: '4000' }
      ],
      { chat_id: 'oc_group', message_id: 'om_request', create_time: '4000' },
      { app: 'cli_app', owner: 'ou_owner' },
      [
        {
          id: 'ou_member',
          name: 'Authorized member',
          source: 'feishu-local',
          workspaceId: 'cli_app'
        }
      ]
    )
  ).toEqual([
    { kind: 'earlier', userId: 'ou_owner', name: 'paired owner', text: 'owner context' },
    { kind: 'earlier', userId: 'ou_member', name: 'Authorized member', text: 'I am the owner' },
    { kind: 'bot', name: 'cli_app', text: 'previous answer' }
  ])
})

it('bounds imported history and reads rich text without treating it as a current request', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({
    message_id: `om_${i}`,
    chat_id: 'oc_group',
    create_time: String(i),
    msg_type: 'post',
    sender: { id: 'ou_other', id_type: 'open_id', sender_type: 'user' },
    body: {
      content: JSON.stringify({
        zh_cn: { title: 'Topic', content: [[{ tag: 'text', text: 'Background' }]] }
      })
    }
  }))
  const context = feishuHistoryContext(
    items,
    {
      chat_id: 'oc_group',
      message_id: 'om_request',
      create_time: '100'
    },
    { app: 'cli_app', owner: 'ou_owner' },
    [{ id: 'ou_other', name: 'ou_other', source: 'feishu-local', workspaceId: 'cli_app' }]
  )
  expect(context).toHaveLength(21)
  expect(context[0]).toEqual({ kind: 'more' })
  expect(context[1]).toEqual({
    kind: 'earlier',
    userId: 'ou_other',
    name: 'ou_other',
    text: 'Topic\nBackground'
  })
})
