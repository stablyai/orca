import { createElement, type ReactNode } from 'react'

// Host-node stand-ins for the settings frame and list rows, so screen tests read titles and values
// as props and reach accessories without the native chrome. Element props render as children:
// JSON-serialising an element prop would walk its owner fiber.
type Props = {
  [prop: string]: unknown
  children?: ReactNode
  overlays?: ReactNode
  trailing?: ReactNode
  footer?: ReactNode
  leading?: ReactNode
  accessory?: ReactNode
  detail?: ReactNode
}

export const settingsFrameDouble = {
  SettingsScreen: ({ children, overlays, trailing, ...rest }: Props) =>
    createElement('SettingsScreen', rest, trailing, children, overlays),
  SettingsNavBar: ({ trailing, ...rest }: Props) => createElement('SettingsNavBar', rest, trailing),
  SettingsSection: ({ children, footer, ...rest }: Props) =>
    createElement('SettingsSection', rest, children, footer),
  SettingsNote: ({ children, ...rest }: Props) => createElement('SettingsNote', rest, children),
  SettingsEmptyRow: ({ children }: Props) => createElement('SettingsEmptyRow', null, children),
  settingsScreenStyles: {}
}

export const listRowDouble = {
  ListRow: ({ leading, accessory, detail, ...rest }: Props) =>
    createElement('ListRow', rest, leading, detail, accessory)
}

export const listGroupDouble = {
  LIST_ROW_PADDING: 16,
  LIST_LEADING_SLOT: 24,
  LIST_LEADING_INSET: 52,
  ListGroup: ({ children }: Props) => createElement('ListGroup', null, children),
  SectionHeader: ({ title }: Props) => createElement('SectionHeader', { title }),
  // ListRow's code lives in ListGroup.tsx, so a mocked ListGroup must provide it too.
  ListRow: listRowDouble.ListRow
}
