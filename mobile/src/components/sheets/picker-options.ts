import type { ReactNode } from 'react'

export type PickerOption<T extends string = string> = {
  value: T
  label: string
  subtitle?: string
  disabled?: boolean
  renderIcon?: (selected: boolean) => ReactNode
  /** Options sharing a section are grouped under its header, in the order they appear. */
  section?: string
}

export type PickerSection<T extends string = string> = {
  title: string | undefined
  options: PickerOption<T>[]
}

/** Runs of options with the same `section`, in the order they appear. */
export function groupPickerSections<T extends string>(
  options: PickerOption<T>[]
): PickerSection<T>[] {
  const sections: PickerSection<T>[] = []
  for (const option of options) {
    const last = sections.at(-1)
    if (last && last.title === option.section) {
      last.options.push(option)
    } else {
      sections.push({ title: option.section, options: [option] })
    }
  }
  return sections
}

/** Options whose label or subtitle contains the query, ignoring case. */
export function filterPickerOptions<T extends string>(
  options: PickerOption<T>[],
  query: string
): PickerOption<T>[] {
  const needle = query.trim().toLocaleLowerCase()
  return needle
    ? options.filter((option) =>
        `${option.label} ${option.subtitle ?? ''}`.toLocaleLowerCase().includes(needle)
      )
    : options
}
