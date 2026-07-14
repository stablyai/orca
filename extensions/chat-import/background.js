// background.js
import { pushRecentSync } from './recent-syncs.js'

const HOST = 'com.orca.chatimport'
let port = null
let seq = 0
const pending = new Map()

function getPort() {
  if (port) return port
  port = chrome.runtime.connectNative(HOST)
  port.onMessage.addListener((resp) => {
    const id = resp && resp._id
    const cb = id != null && pending.get(id)
    if (cb) {
      pending.delete(id)
      cb.resolve(resp)
    }
  })
  port.onDisconnect.addListener(() => {
    const msg =
      (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'native host disconnected'
    for (const cb of pending.values()) cb.reject(new Error(msg))
    pending.clear()
    port = null
  })
  return port
}

function native(msg) {
  return new Promise((resolve, reject) => {
    const _id = ++seq
    pending.set(_id, { resolve, reject })
    try {
      getPort().postMessage({ ...msg, _id })
    } catch (e) {
      pending.delete(_id)
      reject(e)
    }
  })
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'GET_INGESTED_IDS') {
    native({ type: 'INGESTED_IDS', source: msg.source })
      .then((r) =>
        sendResponse(r && r.error ? { error: r.error } : { ids: (r && r.externalIds) || [] })
      )
      .catch((e) => sendResponse({ error: e.message }))
    return true
  }
  if (msg.type === 'PUSH') {
    native({ type: 'INGEST', conv: msg.conv })
      .then((r) => {
        if (r && r.error) {
          sendResponse({ error: r.error })
          return
        }
        sendResponse({ ok: true, id: r && r.id })
        // 팝업 "최근 동기화" 목록용 기록. 응답은 이미 보냈으므로 실패해도 동기화 결과에 영향 없음.
        chrome.storage.local.get('recentSyncs').then(({ recentSyncs: list }) => {
          const recentSyncs = pushRecentSync(
            list || [],
            {
              title: msg.conv.title,
              source: msg.conv.source,
              date: msg.conv.updatedAt || new Date().toISOString()
            },
            30
          )
          chrome.storage.local.set({ recentSyncs })
        })
      })
      .catch((e) => sendResponse({ error: e.message }))
    return true
  }
  if (msg.type === 'PROGRESS') {
    chrome.storage.local.set({
      syncProgress: { source: msg.source, done: msg.done, total: msg.total, ts: Date.now() }
    })
    const pctText = msg.total ? String(Math.round((msg.done / msg.total) * 100)) : ''
    chrome.action.setBadgeBackgroundColor({ color: '#4f6bed' })
    chrome.action.setBadgeText({ text: msg.done >= msg.total ? '' : pctText ? pctText : '' })
    if (msg.done >= msg.total) setTimeout(() => chrome.action.setBadgeText({ text: '' }), 1500)
    return false
  }
  if (msg.type === 'SYNC_DONE') {
    // 완료 결과를 저장해 팝업이 닫혀 있어도 재오픈 시 최종 상태를 복원할 수 있게 한다.
    // 진행 기록(syncProgress)은 지워 완료 후 "가져오는 중" 잔상이 남지 않게 한다.
    chrome.storage.local.set({
      syncResult: {
        source: msg.source,
        count: msg.count,
        total: msg.total,
        skipped: msg.skipped,
        canceled: !!msg.canceled,
        ts: Date.now()
      }
    })
    chrome.storage.local.remove(['syncProgress', 'forceResync'])
    chrome.action.setBadgeText({ text: '' })
    return false
  }
})
