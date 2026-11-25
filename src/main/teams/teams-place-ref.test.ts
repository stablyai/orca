import { describe, expect, it } from 'vitest'
import { formatTeamsRef, parseTeamsPlace } from './teams-place-ref'

const TEAM = '2f1a7a5e-3b0c-4c8e-9f3e-6c1d2b7a9e10'
const CHANNEL = '19:a1b2c3d4e5f6@thread.tacv2'
const CHAT =
  '19:8f0e2c1b-1d7a-4e3e-9c5b-0b9e6f2d4a11_6b3e1f7c-2a9d-4c8b-8e1f-3d5a7b9c0e22@unq.gbl.spaces'

describe('parseTeamsPlace', () => {
  it('reads back every ref it prints', () => {
    for (const ref of [
      `teams:chat/${CHAT}`,
      `teams:chat/${CHAT}/1732550000000`,
      `teams:channel/${TEAM}/${CHANNEL}`,
      `teams:channel/${TEAM}/${CHANNEL}/1732550000000`,
      `teams:channel/${TEAM}/${CHANNEL}/1732550000000/1732550099999`
    ]) {
      const place = parseTeamsPlace(ref)
      expect(place).not.toBeNull()
      expect(formatTeamsRef(place!)).toBe(ref)
    }
  })

  it("reads Teams' Copy link for a channel, a chat message and a reply", () => {
    expect(
      parseTeamsPlace(
        `https://teams.microsoft.com/l/channel/${encodeURIComponent(CHANNEL)}/General?groupId=${TEAM}&tenantId=x`
      )
    ).toEqual({ kind: 'channel', teamId: TEAM, channelId: CHANNEL })
    expect(
      parseTeamsPlace(
        `https://teams.microsoft.com/l/message/${encodeURIComponent(CHAT)}/1732550000000?context=%7B%22contextType%22%3A%22chat%22%7D`
      )
    ).toEqual({ kind: 'chat', chatId: CHAT, messageId: '1732550000000' })
    expect(
      parseTeamsPlace(
        `https://teams.microsoft.com/l/message/${encodeURIComponent(CHANNEL)}/1732550099999?groupId=${TEAM}&parentMessageId=1732550000000`
      )
    ).toEqual({
      kind: 'channel',
      teamId: TEAM,
      channelId: CHANNEL,
      messageId: '1732550000000',
      replyId: '1732550099999'
    })
  })

  it('refuses ids that could steer a Graph URL elsewhere', () => {
    for (const input of [
      'teams:chat/19:abc@thread.v2/../../me',
      'teams:chat/19:abc?x=1@thread.v2',
      `teams:chat/${CHAT}/12a`,
      `teams:channel/not-a-guid/${CHANNEL}`,
      `teams:channel/${TEAM}/19:a#b@thread.tacv2`,
      `teams:channel/${TEAM}/${CHANNEL}/1/2/3`,
      `https://evil.example/l/channel/${encodeURIComponent(CHANNEL)}/x?groupId=${TEAM}`,
      `http://teams.microsoft.com/l/channel/${encodeURIComponent(CHANNEL)}/x?groupId=${TEAM}`,
      `https://teams.microsoft.com/l/message/${encodeURIComponent('19:a/../b@thread.v2')}/1`,
      'General'
    ]) {
      expect(parseTeamsPlace(input), input).toBeNull()
    }
  })
})
