// Match Expo root reset/id: definite html/body/root heights prevent silent zero-height lists with accessible but untappable rows.
// Inline under existing unsafe-inline style CSP to avoid a collapsed first frame; RN-Web owns body margin reset.
export const MOBILE_WEB_APP_ROOT_RESET =
  '<style id="expo-reset">html,body{height:100%}body{overflow:hidden}' +
  '#root{display:flex;height:100%;flex:1}</style>'

// Use zero-specificity native parity: remove text-field focus rings only; keyboard buttons keep browser rings.
// Disable body text selection/callout to prevent WebKit/Android long-press interference, including portaled modals; fields opt back in.
// Stop the WebView rubber-banding the whole page (headers included) when an inner list hits its end; inner scrollers keep their bounce.
export const MOBILE_WEB_APP_NATIVE_PARITY_STYLE =
  '<style id="orca-native-parity">:where(input:focus,textarea:focus){outline:none}' +
  ':where(html){overscroll-behavior:none}' +
  ':where(body){-webkit-user-select:none;user-select:none;-webkit-touch-callout:none}' +
  ':where(input,textarea,[contenteditable]){-webkit-user-select:text;user-select:text;' +
  '-webkit-touch-callout:default}</style>'
