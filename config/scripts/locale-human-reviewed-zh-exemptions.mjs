// These zh keys carry human-reviewed copy from translation PRs (#14775, #6997) that the
// generic glossary (Active: '当前', 智能体→代理, Orca 手机端→Orca Mobile) would clobber.
// Exempt them so repair keeps the reviewed values.

const HUMAN_REVIEWED_ZH_KEYS = new Set([
  // Keep-awake chip: #14775 chose 生效中/智能体 over the generic 当前/代理.
  'auto.components.status.bar.CaffeinateStatusSegment.active',
  'auto.components.status.bar.CaffeinateStatusSegment.autoDescription',
  'auto.components.settings.agent-awake-copy.e5995ce268',
  'auto.components.settings.agent-awake-copy.95d3031db2',
  'auto.components.settings.agent-awake-copy.a42f6fbdd8',
  'auto.components.mobile.agent-awake-copy.e5995ce268',
  'auto.components.mobile.agent-awake-copy.95d3031db2',
  'auto.components.mobile.agent-awake-copy.a42f6fbdd8',
  'auto.components.settings.AgentAwakeSetting.auto',
  // Orca Mobile: #6997 chose 手机端 over the Latin brand form.
  'menu.showMobileButton',
  'auto.components.sidebar.SidebarNav.1b5c41caee',
  'auto.components.settings.AppearancePane.9da1020447',
  'auto.components.settings.MobileSettingsPane.1de96ec8a6',
  'auto.components.settings.appearance.search.1de96ec8a6',
  'auto.components.settings.mobile.settings.search.1de96ec8a6',
  'auto.components.mobile.MobilePane.9da1020447',
  'auto.components.mobile.MobilePane.1de96ec8a6',
  'auto.components.mobile.MobileHero.1de96ec8a6',
  'auto.components.mobile.MobileHero.5410d55d79'
])

export function isHumanReviewedZhKey(key) {
  return HUMAN_REVIEWED_ZH_KEYS.has(key)
}
