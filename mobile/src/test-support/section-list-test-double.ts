import { createElement, Fragment, type ReactNode } from 'react'

type SectionListTestDoubleProps = {
  sections: readonly { data: readonly unknown[] }[]
  keyExtractor: (item: unknown, index: number) => string
  renderItem: (info: { item: unknown; index: number; section: unknown }) => ReactNode
  renderSectionHeader?: (info: { section: unknown }) => ReactNode
}

/** A `react-native` SectionList stand-in that renders every header and row the
 *  real list would, so tests exercise them instead of an empty host node. */
export function SectionListTestDouble({
  sections,
  keyExtractor,
  renderItem,
  renderSectionHeader
}: SectionListTestDoubleProps): ReactNode {
  return createElement(
    'SectionList',
    { sections },
    sections.map((section, sectionIndex) =>
      createElement(
        Fragment,
        { key: sectionIndex },
        renderSectionHeader?.({ section }),
        section.data.map((item, index) =>
          createElement(
            Fragment,
            { key: keyExtractor(item, index) },
            renderItem({ item, index, section })
          )
        )
      )
    )
  )
}
