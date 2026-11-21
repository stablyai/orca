import { DrawnSegmentedControl, type MobileSegmentedControlProps } from './DrawnSegmentedControl'
import { NativeSegmentedControl } from './NativeSegmentedControl'

export type { MobileSegment, MobileSegmentedControlProps } from './DrawnSegmentedControl'

/** The platform's own segmented control; the drawn one where it can't show trailing marks or scroll. */
export function MobileSegmentedControl<Value extends string>(
  props: MobileSegmentedControlProps<Value>
) {
  const native =
    !props.scrollWhenCrowded && props.segments.every((segment) => segment.trailing === undefined)
  return native ? <NativeSegmentedControl {...props} /> : <DrawnSegmentedControl {...props} />
}
