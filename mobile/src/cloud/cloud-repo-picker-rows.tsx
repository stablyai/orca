import type { ReactElement } from 'react'
import { ListRow } from '../components/list/ListGroup'
import type { Translate } from '../i18n/mobile-i18n'

/**
 * The repository picker's rows: recents and the team's projects, "No repository (blank project)",
 * then "Other repository…" for any other repo (the free-text field). Keyed rows, not a fragment, so
 * the group draws its separators.
 */
export function cloudRepoPickerRows(args: {
  choices: readonly string[]
  repo: string
  typing: boolean
  disabled: boolean
  t: Translate
  onPick: (repo: string) => void
  onOther: () => void
}): ReactElement[] {
  if (args.choices.length === 0) {
    return []
  }
  return [
    ...args.choices.map((choice) => (
      <ListRow
        key={`repo:${choice}`}
        title={choice}
        selected={!args.typing && args.repo === choice}
        accessibilityRole="radio"
        disabled={args.disabled}
        onPress={() => args.onPick(choice)}
      />
    )),
    <ListRow
      key="repo:none"
      title={args.t('cloud.new.repoNone', 'No repository (blank project)')}
      selected={!args.typing && args.repo === ''}
      accessibilityRole="radio"
      disabled={args.disabled}
      onPress={() => args.onPick('')}
    />,
    <ListRow
      key="repo:other"
      title={args.t('cloud.new.repoOther', 'Other repository…')}
      selected={args.typing}
      accessibilityRole="radio"
      disabled={args.disabled}
      onPress={args.onOther}
    />
  ]
}
