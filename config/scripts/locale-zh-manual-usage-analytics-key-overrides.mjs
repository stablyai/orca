// Human-reviewed Simplified Chinese for statistics and usage analytics.
// Why: these strings need key-level context; broad phrase replacement would corrupt code tokens.
export const ZH_MANUAL_USAGE_ANALYTICS_KEY_OVERRIDES = {
  // Statistics and usage analytics.
  'auto.components.stats.ClaudeUsagePane.0cb1a36d7d': {
    zh: '读取本地 Claude 用量日志，显示 token、模型和会话统计。'
  },
  'auto.components.stats.ClaudeUsagePane.2b8a2f14aa': { zh: '输出 token' },
  'auto.components.stats.ClaudeUsagePane.51ae85fa00': {
    zh: '缓存复用率 = 缓存读取 token /（输入 token + 缓存读取 token）。'
  },
  'auto.components.stats.ClaudeUsagePane.5ce4842c2c': { zh: '所有本地 Claude 用量' },
  'auto.components.stats.ClaudeUsagePane.6afacbee37': { zh: 'Claude 用量统计' },
  'auto.components.stats.ClaudeUsagePane.7e76c84153': { zh: '最近会话' },
  'auto.components.stats.ClaudeUsagePane.ea71fae8fc': { zh: '输入 token' },
  'auto.components.stats.CodexUsagePane.13badcd8f2': {
    zh: '读取本地 Codex 用量日志，显示 token、模型和会话统计。'
  },
  'auto.components.stats.CodexUsagePane.0cb0983c07': { zh: '最近会话' },
  'auto.components.stats.CodexUsagePane.247c93ca92': { zh: '• 价格为推算值' },
  'auto.components.stats.CodexUsagePane.408210470c': { zh: 'Codex 用量统计' },
  'auto.components.stats.CodexUsagePane.4fe8820098': { zh: '所有本地 Codex 用量' },
  'auto.components.stats.CodexUsagePane.5d8eba87bd': { zh: '输出 token' },
  'auto.components.stats.CodexUsagePane.94ac1f1ee7': {
    zh: '推理 token 仅供查看；费用只按未缓存输入、缓存输入和输出计算。'
  },
  'auto.components.stats.CodexUsagePane.e365eaa6fd': { zh: '输入 token' },
  'auto.components.stats.OpenCodeUsagePane.040c044d39': { zh: '按模型' },
  'auto.components.stats.OpenCodeUsagePane.048ffe4d65': { zh: '用量最高的项目：' },
  'auto.components.stats.OpenCodeUsagePane.144a6050e9': { zh: '所有本地 OpenCode 用量' },
  'auto.components.stats.OpenCodeUsagePane.15c34d4b08': { zh: '记录的费用' },
  'auto.components.stats.OpenCodeUsagePane.349f7c3f5c': { zh: '总计' },
  'auto.components.stats.OpenCodeUsagePane.4799177b1c': { zh: '最近会话' },
  'auto.components.stats.OpenCodeUsagePane.7aa4d8ce35': { zh: '输出 token' },
  'auto.components.stats.OpenCodeUsagePane.7e9433469a': { zh: '会话/事件' },
  'auto.components.stats.OpenCodeUsagePane.a15206a63a': { zh: '最常用模型：' },
  'auto.components.stats.OpenCodeUsagePane.b5ed5c9fd0': { zh: '时间范围' },
  'auto.components.stats.OpenCodeUsagePane.b8b3522436': {
    zh: '读取本地 OpenCode 用量日志，显示 token、模型和会话统计。'
  },
  'auto.components.stats.OpenCodeUsagePane.bb6363e08c': {
    zh: '此范围内暂无本地 OpenCode 用量记录。'
  },
  'auto.components.stats.OpenCodeUsagePane.bea80ceae0': { zh: 'OpenCode 用量统计' },
  'auto.components.stats.OpenCodeUsagePane.d416f5cf92': { zh: '事件' },
  'auto.components.stats.OpenCodeUsagePane.d637a892ed': { zh: '输入 token' },
  'auto.components.stats.OpenCodeUsagePane.e5bb23d85e': {
    zh: '如果助手消息中记录了费用，此处会从本地 OpenCode 数据库读取。'
  },
  'auto.components.stats.ShareUsageButton.bce08eccb9': { zh: '分享用量' },
  'auto.components.stats.ShareUsageCard.2d9eb39264': { zh: 'token 总数' },
  'auto.components.stats.ShareUsageCard.66c83284cf': { zh: '每日 token' },
  'auto.components.stats.ShareUsageCard.6adac63cfe': { zh: '轮次' },
  'auto.components.stats.ShareUsageCard.b760c0b622': { zh: '最常用模型' },
  'auto.components.stats.ShareUsageCard.da62578d9d': { zh: '用量' },
  'auto.components.stats.StatsPane.42d3e0bdf7': { zh: '用量分析提供方：{{value0}}' },
  'auto.components.stats.StatsPane.9dbec9e675': { zh: '已启动的智能体' },
  'auto.components.stats.StatsPane.a58aba506f': { zh: '已创建的 PR' },
  'auto.components.stats.StatsPane.c79f073d4c': { zh: '用量分析' },
  'auto.components.stats.stats.search.0e2a0b6431': { zh: '用量' },
  'auto.components.stats.UsageBreakdownSection.247c93ca92': { zh: '• 价格为推算值' },
  'auto.components.stats.UsageOverviewPane.2d13e57f72': { zh: '启用 OpenCode' },
  'auto.components.stats.UsageOverviewPane.33f7b043d2': { zh: '提供方' },
  'auto.components.stats.UsageOverviewPane.3887b94ce5': { zh: 'token 总数' },
  'auto.components.stats.UsageOverviewPane.49405ccc8d': { zh: '开始统计 token' },
  'auto.components.stats.UsageOverviewPane.55c910f4f1': { zh: '- 部分模型价格不可用' },
  'auto.components.stats.UsageOverviewPane.60002bb22f': {
    zh: '暂未找到本地 Claude、Codex 或 OpenCode 用量。下次智能体会话写入 token 日志后，概览会自动显示数据。'
  },
  'auto.components.stats.UsageOverviewPane.6c00c46815': {
    zh: '启用提供方后，Orca 会扫描本地智能体日志并汇总 token 用量。'
  },
  'auto.components.stats.UsageOverviewPane.70f36452d4': { zh: '缓存占比' },
  'auto.components.stats.UsageOverviewPane.c760c481c5': { zh: '用量概览' },
  'auto.components.stats.usage.overview.sections.1dd166c920': { zh: '更少' },
  'auto.components.stats.usage.overview.sections.3a795542fa': { zh: '综合 token 分布' },
  'auto.components.stats.usage.overview.sections.3bc4a01b24': {
    zh: '汇总所有已启用提供方的输入、输出和缓存 token。'
  },
  'auto.components.stats.usage.overview.sections.3de9bf87fc': { zh: '暂无模型' },
  'auto.components.stats.usage.overview.sections.4ff104da47': { zh: 'token 分布' },
  'auto.components.stats.usage.overview.sections.52d9221dc0': { zh: '近期 token 活动热图' },
  'auto.components.stats.usage.overview.sections.c424eb3f8e': { zh: '最高：' },
  'auto.components.stats.usage.overview.sections.f28ff1f852': {
    zh: '近期 Claude、Codex 和 OpenCode 的综合 token 活动。'
  },
  'auto.components.stats.usage.overview.sections.f6df0d7d6d': { zh: '更多' }
}
