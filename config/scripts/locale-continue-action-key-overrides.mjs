// "Continue" here is the action, not the Continue agent — see locale-continue-action-exemptions.mjs.
// The brand guard had already flattened these to Latin, so repair needs the wording restored.

export const CONTINUE_ACTION_KEY_OVERRIDES = {
  'auto.components.mobile.MobileHero.a8fb43cf1c': { ko: '계속', zh: '继续', ja: '続ける' },
  'components.agentSessionContinuation.continueInNewSession': {
    ko: '새 세션에서 계속…',
    zh: '在新会话中继续…',
    ja: '新規セッションで続ける…'
  },
  'components.agentSessionContinuation.dialogTitle': {
    ko: '새 세션에서 계속',
    zh: '在新会话中继续',
    ja: '新規セッションで続ける'
  }
}
