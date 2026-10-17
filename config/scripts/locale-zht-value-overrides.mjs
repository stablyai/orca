// Post-conversion corrections for OpenCC's `cn → twp` output.
//
// Why fixes at all: `twp`'s phrase dictionary is neither complete nor idempotent,
// so in some contexts it emits a mainland form the Taiwan UI never uses (it maps
// 复制→複製 alone but 进行复制→進行復制). Re-running OpenCC does not remove these —
// iterating to a fixed point makes two cases worse (游標→遊標, 程序→程式 for
// "process") — so each correction is an explicit, reviewable entry here.
//
// Every rule is evidence-backed. The reference corpus is the Traditional Chinese
// language pack Microsoft ships for VS Code, about 2 MB of reviewed Taiwan UI
// terminology. A rule belongs here only when that corpus shows the `twp` form
// essentially unused and the replacement well attested; a style preference does
// not qualify. Hit counts are recorded as "twp form N vs Taiwan form M".
export const ZHT_PHRASE_FIXES = [
  // Permission: 許可權 0 vs 權限 84.
  ['許可權', '權限'],
  // Account: 賬戶 0 vs 帳戶 111.
  ['賬戶', '帳戶'],
  // Background: 後臺 0 ("back stage") vs 後台 1.
  ['後臺', '後台'],
  // Save/store: 存儲 is not a Taiwan word; 儲存 642 (保存 5).
  ['存儲', '儲存'],
  ['保存', '儲存'],
  // Send: 發送 0 vs 傳送 118.
  ['發送', '傳送'],
  // Add: 添加 0 vs 新增 359.
  ['添加', '新增'],
  // Font: 字體 2 vs 字型 164.
  ['字體', '字型'],
  // Device: 設備 0 vs 裝置 36.
  ['設備', '裝置'],
  // Run: 運行 4 vs 執行 1050.
  ['運行', '執行'],
  // Info: 信息 0 vs 資訊 211; message: 消息 already 訊息.
  ['信息', '資訊'],
  // Default: 默認 1 vs 預設 380.
  ['默認', '預設'],
  // Open: 打開 2 vs 開啟 1158.
  ['打開', '開啟'],
  // Interface: 接口 0 vs 介面 25.
  ['接口', '介面'],
  // Network: 網絡 0 vs 網路 60.
  ['網絡', '網路'],
  // Mouse/pointer: 鼠標 → 滑鼠 58, 指針 → 指標.
  ['鼠標', '滑鼠'],
  ['指針', '指標'],
  // Video: 視頻 0 vs 影片 11.
  ['視頻', '影片'],
  // Software: 軟件 → 軟體.
  ['軟件', '軟體'],
  // Clipboard: 剪貼板 → 剪貼簿 33.
  ['剪貼板', '剪貼簿'],
  // 云 survived the phrase pass in 云包/云虛擬機; the character map is
  // unambiguous for it (云→雲, and 雲 itself contains no 云).
  ['云', '雲'],
  // twp produced 復制 ("again"+"make") from 进行复制; the source meant 複製.
  ['復制', '複製']
]

/**
 * Rules that need the Simplified source to disambiguate the output.
 *
 * Why: the Simplified catalog distinguishes 進程 ("process") from 程序
 * ("program"), but `twp` maps the former to 程序 and the latter to 程式 — so the
 * two collapse and the output alone cannot say which was meant. Taiwan calls an
 * OS process 行程 (24 corpus hits), and `twp` never emits 程序 for a source that
 * said 程序 (that becomes 程式), so any 程序 left in the output came from 進程.
 * Reads `{ source, from, to }`: when the Simplified value contains `source`,
 * replace `from` in the converted value with `to`. `source` is Simplified — it
 * is matched against zh.json, not against the converted value.
 */
export const ZHT_SOURCE_CONDITIONAL_FIXES = [{ source: '进程', from: '程序', to: '行程' }]
