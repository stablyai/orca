import { defineFixture } from '../component-fixtures/component-fixture'
import { HoldQuitHint } from './HoldQuitNotice'

export const starting = defineFixture({
  width: 360,
  render: () => (
    <div className="rounded-md border border-border bg-popover p-4 text-popover-foreground">
      <HoldQuitHint phase="starting" />
    </div>
  )
})
export const released = defineFixture({
  width: 360,
  render: () => (
    <div className="rounded-md border border-border bg-popover p-4 text-popover-foreground">
      <HoldQuitHint phase="released" />
    </div>
  )
})

export const holding = defineFixture({
  width: 360,
  render: () => (
    <div className="rounded-md border border-border bg-popover p-4 text-popover-foreground">
      <HoldQuitHint phase="holding" />
    </div>
  ),
  interact: async () => {
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
})
