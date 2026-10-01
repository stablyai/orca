import codegenNativeComponent from 'react-native/Libraries/Utilities/codegenNativeComponent'
import type { ViewProps } from 'react-native'
import type {
  BubblingEventHandler,
  Int32,
  WithDefault
} from 'react-native/Libraries/Types/CodegenTypes'

interface TargetedEvent {
  target: Int32
}

/**
 * Event fired when text selection changes in the UITextView.
 * @property target - The view tag identifier
 * @property start - The start index of the selected range (0-based)
 * @property end - The end index of the selected range (0-based, exclusive)
 */
interface SelectionChangeEvent extends TargetedEvent {
  start: Int32
  end: Int32
}

interface NativeProps extends ViewProps {
  allowFontScaling?: WithDefault<boolean, true>
  selectable?: boolean
  /**
   * Callback fired when the text selection changes.
   *
   * @example
   * ```tsx
   * <UITextView
   *   onSelectionChange={(event) => {
   *     console.log('Selection:', event.nativeEvent.start, event.nativeEvent.end);
   *   }}
   * >
   *   Selectable text
   * </UITextView>
   * ```
   */
  onSelectionChange?: BubblingEventHandler<SelectionChangeEvent>
}

export default codegenNativeComponent<NativeProps>('OrcaSelectableText', {
  excludedPlatforms: ['android']
})
