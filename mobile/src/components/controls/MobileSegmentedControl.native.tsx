import { DrawnSegmentedControl, type MobileSegmentedControlProps } from './DrawnSegmentedControl'
import { NativeSegmentedControl } from './NativeSegmentedControl'

export type { MobileSegment, MobileSegmentedControlProps } from './DrawnSegmentedControl'

/** The platform's own segmented control; the drawn one where it can't show trailing marks or scroll. */
export function MobileSegmentedControl<Value extends string>(
  props: MobileSegmentedControlProps<Value>
) {
  // The native control speaks each segment's label, so a custom spoken name stays drawn.
  const native =
    !props.scrollWhenCrowded &&
    props.segments.every(
      (segment) =>
        segment.trailing === undefined &&
        (segment.accessibilityLabel === undefined || segment.accessibilityLabel === segment.label)
    )
  return native ? <NativeSegmentedControl {...props} /> : <DrawnSegmentedControl {...props} />
}
