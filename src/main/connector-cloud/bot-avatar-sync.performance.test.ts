// Guards PR #47381: the icon sync reads the signed-in account from the connector's memory, never through
// the profile read behind `signedInAccount()`, however many bots a pass sends.
import { expect, it, vi } from 'vitest'
import type * as z from 'zod'
import { BotSlackIconShownRecords } from '../bots/bot-slack-icon-shown'
import { BotAvatarSync } from './bot-avatar-sync'
import { ConnectorCloud } from './connector-cloud'
import type { ConnectorResult } from './connector-cloud-request'
import type { ConnectorMachine } from './connector-machine'

async function accountReadsForSends(bots: number): Promise<number> {
  let reads = 0
  const connector = new ConnectorCloud({
    userDataPath: '/nonexistent',
    origin: 'https://cloud.invalid',
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: knownAccount() never touches the machine.
    machine: {} as ConnectorMachine,
    account: () => {
      reads += 1
      return 'acct-1'
    },
    isFenced: () => false,
    mintFor: () => {
      throw new Error('not minted here')
    }
  })
  reads = 0
  const roster = Array.from({ length: bots }, (_, index) => ({
    id: `bot-${index}`,
    folderWorkspaceId: `home-${index}`,
    avatar: 'mascot:A1',
    avatarColor: null,
    avatarOutfit: null,
    slack: { appId: `A${index}`, teamId: 'T1' },
    github: null
  }))
  let sends = 0
  // The real connector's account readers, the profile-reading one included, with only the call stubbed.
  const cloud = {
    knownAccount: () => connector.knownAccount(),
    signedInAccount: () => connector.signedInAccount(),
    call: async <T extends z.ZodType>(
      _path: string,
      _body: unknown,
      schema: T
    ): Promise<ConnectorResult<z.infer<T>>> => {
      sends += 1
      return { ok: true, value: schema.parse(undefined) }
    }
  }
  const sync = new BotAvatarSync({
    bots: {
      enabled: () => true,
      list: () => roster,
      readAvatarImage: async () => null,
      slackIcons: {
        shownRecords: new BotSlackIconShownRecords({
          read: async () => null,
          write: async () => {},
          exists: () => true
        }),
        read: async () => null
      }
    },
    cloud: () => cloud
  })
  sync.changed()
  await vi.waitFor(() => expect(sends).toBe(bots))
  sync.changed()
  return reads
}

it('reads no profile for the account however many bots are sent', async () => {
  expect(await accountReadsForSends(10)).toBe(0)
  expect(await accountReadsForSends(100)).toBe(0)
})
