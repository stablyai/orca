/** Ring colors for the busy spinner: a full-color border with the top edge cut out.
 *
 *  Why a helper: on react-native-web `borderColor` is emitted as four inline longhands, so a
 *  later `borderColor` in the style array silently overwrites a `borderTopColor: 'transparent'`
 *  set by an earlier StyleSheet rule and the spinner renders as a solid ring. Keeping both keys
 *  in one object, gap last, is the only ordering that survives on web and on native. */
export function busyRingColors(color: string): { borderColor: string; borderTopColor: string } {
  return { borderColor: color, borderTopColor: 'transparent' }
}
