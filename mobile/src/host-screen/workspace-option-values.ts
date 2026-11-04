export function summarizeChecklist(
  checkedLabels: readonly string[],
  total: number,
  allLabel: string
): string {
  if (checkedLabels.length >= total) {
    return allLabel
  }
  if (checkedLabels.length === 0) {
    return 'None'
  }
  return checkedLabels.length === 1 ? checkedLabels[0] : `${checkedLabels.length} of ${total}`
}

export function choiceLabel<Id extends string>(
  choices: readonly { id: Id; label: string }[],
  selected: string
): string {
  return choices.find((choice) => choice.id === selected)?.label ?? ''
}
