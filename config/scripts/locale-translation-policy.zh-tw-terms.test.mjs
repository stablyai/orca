import { describe, expect, it } from 'vitest'

import { repairTranslatedValue } from './locale-translation-policy.mjs'

/** Runs the zh-TW repair policy for repository terminology test cases. */
const repairZhTw = (
  enValue,
  localeValue,
  key = 'auto.components.test.zh-tw-repository-glossary'
) =>
  repairTranslatedValue({
    key,
    enValue,
    localeValue,
    locale: 'zh-TW'
  })

describe('locale-translation-policy zh-TW terminology', () => {
  it.each([
    ['反饋', '回饋'],
    ['鏈接', '連結'],
    ['信息', '資訊'],
    ['內存', '記憶體'],
    ['主頁', '首頁'],
    ['特工', 'Agent'],
    ['存儲庫', '存放庫'],
    ['隊列', '佇列'],
    ['文件夾', '資料夾'],
    ['緩存', '快取'],
    ['插件', '外掛'],
    ['創建', '建立'],
    ['嵌套', '巢狀']
  ])('repairs %s without depending on the English source', (source, expected) => {
    expect(repairZhTw('Unrelated English', source)).toBe(expected)
    expect(repairZhTw('Unrelated English', expected)).toBe(expected)
  })

  it('normalizes repository wording for explicit repository tokens', () => {
    expect(repairZhTw('Open repo', '開啟倉庫')).toBe('開啟存放庫')
    expect(repairZhTw('Open repository', '開啟儲存庫')).toBe('開啟存放庫')
    expect(repairZhTw('Browse repositories', '瀏覽倉庫')).toBe('瀏覽存放庫')
  })

  it('does not fire for words that merely contain the repo substring', () => {
    expect(repairZhTw('Report status', '倉庫狀態')).toBe('倉庫狀態')
    expect(repairZhTw('Reposition panel', '儲存庫面板')).toBe('儲存庫面板')
  })

  it('keeps artifacts, child agents, and workers in their UI context', () => {
    expect(repairZhTw('Open Artifacts', '打開文物')).toBe('打開成品')
    expect(repairZhTw('Artifact sharing', '神器分享')).toBe('成品分享')
    expect(repairZhTw('Delete artifact?', '刪除工件？')).toBe('刪除成品？')
    expect(repairZhTw('Show Artifacts', '顯示 Artifacts')).toBe('顯示成品')
    expect(repairZhTw('Show child agents', '顯示兒童 Agent')).toBe('顯示子 Agent')
    expect(repairZhTw('Nested worker depth', '嵌套工人深度')).toBe('巢狀工作者深度')
    expect(repairZhTw('Unrelated English', '文物')).toBe('文物')
    expect(repairZhTw('Unrelated English', '兒童')).toBe('兒童')
  })

  it.each([
    ['auto.components.NewWorkspaceComposerCard.ac3748dcda', 'Create From', '創建自', '建立來源'],
    [
      'auto.components.shared.macFolderAccessFolderName.documents',
      'Documents folder',
      '文件夾',
      '文件資料夾'
    ],
    [
      'auto.components.settings.ReleaseChannelSection.cacheHint',
      'Build lists are cached for 5 minutes. Refresh to check for new builds.',
      '建立清單緩存 5 分鐘。重新整理以檢查新版本。',
      '版本清單會快取 5 分鐘。重新整理以檢查新版本。'
    ],
    [
      'auto.components.skills.SkillDelete.reasonPlugin',
      'Installed by a plugin — remove the plugin instead',
      '由插件安裝 - 刪除插件',
      '由外掛安裝，請移除外掛'
    ],
    [
      'auto.components.activity.ActivityPrototypePage.markThreadRead',
      'Mark thread as read',
      '將線程標記為已讀',
      '將討論串標示為已讀'
    ],
    [
      'auto.components.activity.ActivityPrototypePage.59b131fbd9',
      'Mark thread unread',
      '將話題標記為未讀',
      '將討論串標示為未讀'
    ]
  ])('uses context-specific zh-TW wording for %s', (key, enValue, localeValue, expected) => {
    expect(repairZhTw(enValue, localeValue, key)).toBe(expected)
  })

  it('does not turn a CPU thread into a discussion thread', () => {
    expect(repairZhTw('CPU thread count', '線程數')).toBe('執行緒數')
  })
})
