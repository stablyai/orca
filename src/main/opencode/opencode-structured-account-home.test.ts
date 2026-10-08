import { describe, expect, it } from 'vitest'
import type { ManagedDataAccountsState } from '../../shared/managed-account-types'
import { restoreManagedDataAccountEnvironment } from '../../shared/managed-data-account-environment'
import {
  environmentForStructuredOpenCodeAccountHome,
  resolveStructuredOpenCodeAccountHome
} from './opencode-structured-account-home'

const first = '123e4567-e89b-42d3-a456-426614174000'
const second = '123e4567-e89b-42d3-a456-426614174001'

function managedAccounts() {
  let activeAccountId: string | null = first
  let available = new Set([first, second])
  return {
    list: (): ManagedDataAccountsState => ({
      accounts: [...available].map((id) => ({ id, label: id, integrations: [], createdAt: 0 })),
      activeAccountId
    }),
    restoreOriginalEnvironment: (environment: Record<string, string | undefined>) =>
      restoreManagedDataAccountEnvironment(environment),
    environmentForAccount: (_provider: 'opencode' | 'devin', id: string) => {
      if (!available.has(id)) {
        throw new Error('Managed account not found.')
      }
      return {
        XDG_DATA_HOME: `/profiles/${id}/data`,
        XDG_STATE_HOME: `/profiles/${id}/state`,
        OPENCODE_DB: 'opencode.db',
        OPENCODE_AUTH_CONTENT: ''
      }
    },
    select: (id: string | null) => {
      activeAccountId = id
    },
    remove: (id: string) => {
      available = new Set([...available].filter((entry) => entry !== id))
    }
  }
}

describe('structured OpenCode account binding', () => {
  it('records only that the chat has no managed profile', () => {
    const accounts = managedAccounts()
    accounts.select(null)
    expect(resolveStructuredOpenCodeAccountHome({ managedAccounts: accounts })).toEqual({
      kind: 'opencode',
      locator: { kind: 'unmanaged' }
    })
  })

  it('uses the pinned managed profile after selection changes and refuses removal', () => {
    const accounts = managedAccounts()
    const binding = resolveStructuredOpenCodeAccountHome({ managedAccounts: accounts })
    accounts.select(second)
    const environment = environmentForStructuredOpenCodeAccountHome(binding, {
      managedAccounts: accounts,
      baseEnvironment: { PATH: '/bin' }
    })
    expect(environment.XDG_DATA_HOME).toBe(`/profiles/${first}/data`)
    expect(environment.OPENCODE_DB).toBe('opencode.db')
    expect(resolveStructuredOpenCodeAccountHome({ managedAccounts: accounts }).locator).toEqual({
      kind: 'managed',
      managedProfileId: second
    })
    accounts.remove(first)
    expect(() =>
      environmentForStructuredOpenCodeAccountHome(binding, {
        managedAccounts: accounts,
        baseEnvironment: {}
      })
    ).toThrow('Managed account not found.')
  })

  it("passes the user's inline credentials, relative paths and database through unchanged", () => {
    const accounts = managedAccounts()
    accounts.select(null)
    const baseEnvironment = {
      PATH: '/bin',
      HOME: 'relative/home',
      XDG_DATA_HOME: 'relative/data',
      XDG_STATE_HOME: 'relative/state',
      OPENCODE_DB: 'custom.db',
      OPENCODE_AUTH_CONTENT: '{"provider":{"type":"api","key":"inline"}}'
    }
    const binding = resolveStructuredOpenCodeAccountHome({ managedAccounts: accounts })
    expect(
      environmentForStructuredOpenCodeAccountHome(binding, {
        managedAccounts: accounts,
        baseEnvironment
      })
    ).toEqual(baseEnvironment)
  })

  it("undoes Orca's inherited managed overlay before passing the environment through", () => {
    const accounts = managedAccounts()
    accounts.select(null)
    const environment = environmentForStructuredOpenCodeAccountHome(
      { kind: 'opencode', locator: { kind: 'unmanaged' } },
      {
        managedAccounts: accounts,
        baseEnvironment: {
          ORCA_DATA_ACCOUNT_PROVIDER: 'opencode',
          ORCA_DATA_ACCOUNT_DATA_HOME: '/old/data',
          ORCA_DATA_ACCOUNT_STATE_HOME: '/old/state',
          ORCA_DATA_ACCOUNT_ORIGINAL_ENV: JSON.stringify({
            XDG_DATA_HOME: '/original/data',
            XDG_STATE_HOME: null,
            OPENCODE_DB: 'original.db',
            OPENCODE_AUTH_CONTENT: null
          }),
          XDG_DATA_HOME: '/old/data',
          XDG_STATE_HOME: '/old/state',
          OPENCODE_DB: 'opencode.db',
          OPENCODE_AUTH_CONTENT: '',
          PATH: '/bin'
        }
      }
    )
    expect(environment).toEqual({
      XDG_DATA_HOME: '/original/data',
      OPENCODE_DB: 'original.db',
      PATH: '/bin'
    })
  })
})
