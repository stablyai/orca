import { describe, expectTypeOf, it } from 'vitest'
import type {
  RuntimeMobileSessionClientTab,
  RuntimeMobileSessionTabsResult
} from '../../../src/shared/runtime-types'
import type {
  FieldsRetypedByPhone,
  PhoneKeysTakenByDesktop
} from '../test-support/desktop-contract-type-checks'
import type {
  MobileSessionTab,
  MobileTerminalTabPhoneFields,
  SessionTabsResult
} from './mobile-session-route-types'

type DesktopTab<Type> = Extract<RuntimeMobileSessionClientTab, { type: Type }>
type PhoneTab<Type> = Extract<MobileSessionTab, { type: Type }>

describe('the phone session tabs against the desktop contract', () => {
  it('keeps phone-only tab fields off the names the desktop tab uses', () => {
    expectTypeOf<
      PhoneKeysTakenByDesktop<MobileTerminalTabPhoneFields, DesktopTab<'terminal'>>
    >().toBeNever()
  })

  it('accepts every value the desktop sends for a field the phone also names', () => {
    expectTypeOf<FieldsRetypedByPhone<DesktopTab<'terminal'>, PhoneTab<'terminal'>>>().toBeNever()
    expectTypeOf<
      FieldsRetypedByPhone<DesktopTab<'agent-session'>, PhoneTab<'agent-session'>>
    >().toBeNever()
    expectTypeOf<FieldsRetypedByPhone<DesktopTab<'markdown'>, PhoneTab<'markdown'>>>().toBeNever()
    expectTypeOf<FieldsRetypedByPhone<DesktopTab<'file'>, PhoneTab<'file'>>>().toBeNever()
    expectTypeOf<FieldsRetypedByPhone<DesktopTab<'browser'>, PhoneTab<'browser'>>>().toBeNever()
    expectTypeOf<
      FieldsRetypedByPhone<RuntimeMobileSessionTabsResult, SessionTabsResult>
    >().toBeNever()
  })

  it('has a phone tab for every tab type the desktop publishes', () => {
    expectTypeOf<
      Exclude<RuntimeMobileSessionClientTab['type'], MobileSessionTab['type']>
    >().toBeNever()
  })
})
