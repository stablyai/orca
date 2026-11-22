import type { ScreenHeaderAction } from '../../components/nav-bar/screen-header-props'

/** A header button; the drawn header can also spin it or mark what it opens as showing. */
export type HomeTabHeaderAction = ScreenHeaderAction & {
  /** Spins the glyph while a refresh it started is in flight. */
  spinning?: boolean
  /** What the button opens is showing. */
  active?: boolean
}

export type HomeTabHeaderProps = {
  title: string
  /** At most two. */
  actions: readonly HomeTabHeaderAction[]
}
