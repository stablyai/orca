import { describe, expect, it } from 'vitest'
import type { Bot } from '../../shared/bot-types'
import { botAccountSwitchBlocker } from './bot-account-switch-blocker'
import { stampBotLinkOwners } from '../../shared/bot-link-owners'

function bot(name: string, links: Partial<Pick<Bot, 'slack' | 'linear' | 'github'>>): Bot {
  return {
    id: name,
    name,
    hostId: 'local',
    folder: name.toLowerCase(),
    folderWorkspaceId: `ws-${name}`,
    agent: 'claude',
    avatar: null,
    paused: false,
    notifications: { needsPermission: true, taskComplete: true, couldNotFinish: true },
    members: [],
    slack: null,
    linear: null,
    github: null,
    chatSessionId: null,
    createdAt: 1,
    updatedAt: 1,
    ...links
  }
}

function blockerOver(bots: Bot[]) {
  return botAccountSwitchBlocker({
    bots: () => ({ list: () => bots }),
    profileId: () => 'profile-1'
  })
}

describe('botAccountSwitchBlocker', () => {
  it('refuses another account while links it did not make exist, and names those bots', () => {
    const blocker = blockerOver([
      bot('Helper', { slack: { appId: 'A1', teamId: 'T1', ownerUserId: 'user-a' } }),
      bot('Quiet', {}),
      bot('Triage', { github: { ownerUserId: 'user-a' } })
    ])

    expect(blocker.refusal('user-b', null)).toBe(
      "Remove these bots' connectors or move the bots first: Helper, Triage."
    )
    expect(blocker.refusal('user-a', null)).toBeNull()
    expect(blocker.refusal('user-a', 'user-b')).toBeNull()
  })

  it('allows any account when no bot has a connector', () => {
    expect(blockerOver([bot('Quiet', {})]).refusal('user-b', 'user-a')).toBeNull()
  })

  it("treats links with no recorded owner as the profile's current account's, and refuses all once it is gone", () => {
    const blocker = blockerOver([bot('Old', { linear: { workspaceId: 'w', workspaceName: 'W' } })])

    expect(blocker.refusal('user-a', 'user-a')).toBeNull()
    expect(blocker.refusal('user-b', 'user-a')).not.toBeNull()
    expect(blocker.refusal('user-a', null)).not.toBeNull()
  })

  it('follows ownership through sign-out, removal and a new account linking', () => {
    const helper = bot('Helper', {})
    // A links Slack, then signs out; the stamp lives on the link, not in a separate record.
    const linkedByA = stampBotLinkOwners(
      helper,
      { ...helper, slack: { appId: 'A1', teamId: 'T1' } },
      () => 'user-a'
    )
    expect(blockerOver([linkedByA]).refusal('user-b', null)).not.toBeNull()
    // The links are removed, so B may sign in; B links GitHub.
    const unlinked = { ...linkedByA, slack: null }
    expect(blockerOver([unlinked]).refusal('user-b', null)).toBeNull()
    const linkedByB = stampBotLinkOwners(unlinked, { ...unlinked, github: {} }, () => 'user-b')
    // After B signs out, A is refused: nothing remembers A once its links went away.
    expect(blockerOver([linkedByB]).refusal('user-a', null)).not.toBeNull()
    expect(blockerOver([linkedByB]).refusal('user-b', null)).toBeNull()
  })

  it("keeps an existing link's owner when the link is edited, and stamps no owner when signed out", () => {
    const helper = bot('Helper', {
      linear: { workspaceId: 'w', workspaceName: 'W', ownerUserId: 'user-a' }
    })
    const edited = stampBotLinkOwners(
      helper,
      { ...helper, linear: { workspaceId: 'w', workspaceName: 'Renamed' } },
      () => 'user-b'
    )
    expect(edited.linear?.ownerUserId).toBe('user-a')
    const signedOut = stampBotLinkOwners(helper, { ...helper, github: {} }, () => null)
    expect(signedOut.github?.ownerUserId).toBeUndefined()
  })
})
