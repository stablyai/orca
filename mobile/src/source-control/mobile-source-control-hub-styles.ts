import { StyleSheet } from 'react-native'
import { spacing } from '../theme/mobile-theme'

// The hub's segmented control, the PR row under the branch header and the tab bodies.
export const hubStyles = StyleSheet.create({
  segments: {
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.xs,
    paddingBottom: spacing.sm
  },
  prGroup: {
    marginTop: spacing.xs
  },
  // Wraps the Changes-only notices and the create-PR entry above the list.
  changesControls: {
    gap: spacing.sm,
    paddingTop: spacing.xs
  },
  // Fills the remaining space below the header/segments/card so each segment's
  // scroll view (SectionList / PR sidebar / history list) expands and scrolls.
  tabBody: {
    flex: 1
  },
  // Keep a previously-visited segment mounted (scroll + fetch state) without
  // participating in layout while another segment is active.
  tabBodyHidden: {
    display: 'none'
  }
})
