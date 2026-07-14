import { topRecentSyncs } from './recent-syncs.js'

const SVC = { 'chatgpt.com': 'ChatGPT', 'claude.ai': 'Claude', 'gemini.google.com': 'Gemini' }
const CODE = { 'chatgpt.com': 'CHATGPT', 'claude.ai': 'CLAUDE', 'gemini.google.com': 'GEMINI' }
const SRC_LABEL = { CHATGPT: 'ChatGPT', CLAUDE: 'Claude.ai', GEMINI: 'Gemini' }
const $ = (id) => document.getElementById(id)

async function currentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const host = tab && tab.url ? new URL(tab.url).hostname : ''
  return { tab, host, name: SVC[host], code: CODE[host] }
}

// 동기화 가능 조건 = 지원 사이트 ∧ 데스크톱 앱 연결. 두 신호는 비동기로 도착하므로
// 각자 도착할 때 상태를 갱신하고 버튼을 다시 평가한다.
let connected = null // null=확인 중, true/false=PING 결과
let site = null // { tab, code } — 지원 사이트일 때만
let syncing = false // 동기화 진행 중
let canceling = false // 중지 요청 후 마무리 대기 중
let needsRefresh = false // content script 부재 등 탭 새로고침 전엔 재시도 무의미

function refreshSyncButton() {
  const btn = $('sync')
  if (syncing) {
    // 동기화 중엔 버튼이 "중지"로 바뀐다(재클릭=취소, 재시작 불가). 중지 처리 중엔 잠금.
    if (canceling) {
      btn.disabled = true
      btn.textContent = '중지 중…'
    } else {
      btn.disabled = false
      btn.textContent = '중지'
    }
    btn.title = ''
    return
  }
  if (needsRefresh) {
    btn.disabled = true
    btn.textContent = '탭 새로고침 필요'
    btn.title = '이 탭을 새로고침한 뒤 다시 시도하세요'
    return
  }
  if (!site) {
    btn.disabled = true
    btn.textContent = '동기화'
    btn.title = '지원 사이트(ChatGPT·Claude·Gemini) 탭에서만 동기화할 수 있어요'
  } else if (!connected) {
    btn.disabled = true
    btn.textContent = connected === null ? '확인 중…' : 'Orca 연동 필요'
    btn.title =
      connected === null ? '' : 'Orca 설정 → Web Chat Import → 브라우저 연동에서 설치하세요'
  } else {
    btn.disabled = false
    btn.textContent = '이 사이트 동기화'
    btn.title = ''
  }
}

// 버튼 클릭 라우터: 동기화 중이면 취소, 아니면 시작. 같은 버튼이 재시작을 유발하지 않는다.
function onSyncButton() {
  if (syncing) cancelSync()
  else startSync()
}

function startSync() {
  if (!site || !connected || syncing) return
  syncing = true
  canceling = false
  refreshSyncButton()
  startProg()
  const force = !!($('force') && $('force').checked)
  chrome.tabs.sendMessage(site.tab.id, { action: 'SYNC', source: site.code, force }, (r) => {
    syncing = false
    canceling = false
    if (chrome.runtime.lastError || !r) {
      // content script가 응답 없음 → 탭 새로고침 전엔 재시도 무의미. 버튼 잠금.
      needsRefresh = true
      $('status').textContent = '오류: 이 탭을 새로고침 후 다시 시도'
    } else if (r.error) {
      $('status').textContent = '오류: ' + r.error
    } else {
      finishProg(r)
    }
    refreshSyncButton()
  })
}

function cancelSync() {
  if (!site || !syncing || canceling) return
  canceling = true
  refreshSyncButton()
  $('status').textContent = '중지 요청됨 · 진행 중인 항목까지 마무리합니다'
  chrome.tabs.sendMessage(site.tab.id, { action: 'CANCEL_SYNC' }, () => {
    void chrome.runtime.lastError
  })
}

// 연결 상태(PING)
chrome.runtime.sendNativeMessage('com.orca.chatimport', { type: 'PING' }, (resp) => {
  const el = $('conn')
  connected = !(chrome.runtime.lastError || !resp)
  if (connected) {
    el.textContent = '연결됨'
    el.className = 'conn ok'
  } else {
    el.textContent = '연동 필요'
    el.className = 'conn bad'
  }
  refreshSyncButton()
})

;(async () => {
  const { tab, name, code } = await currentTab()
  if (name) {
    $('site').innerHTML = `<div class="sub">현재 탭</div>${name}`
    site = { tab, code }
    $('sync').onclick = onSyncButton
    // 팝업은 재실행되면 syncing=false로 시작하므로, 실제 진행 중인지 content
    // script에 물어 버튼을 "중지"로 맞춘다(재클릭으로 중복 동기화 방지).
    chrome.tabs.sendMessage(tab.id, { action: 'SYNC_STATUS' }, (resp) => {
      void chrome.runtime.lastError
      if (resp && resp.syncing) {
        syncing = true
        refreshSyncButton()
      }
    })
  } else {
    $('site').innerHTML = `<div class="sub">지원 사이트가 아님</div>ChatGPT · Claude · Gemini`
  }
  refreshSyncButton()
  // 팝업은 열 때마다 재실행되므로, 마지막 상태를 storage에서 복원한다.
  // 단 (1) 활성/방금 끝난(90초 이내) 동기화이고 (2) 현재 탭 사이트와 같은 소스일
  // 때만 보여준다 — 다른 사이트 결과나 과거 세션 잔상은 복원하지 않고 기본 상태 유지.
  // 진행 중(syncProgress)과 완료 결과(syncResult) 중 더 최신인 것을 그린다.
  const FRESH_MS = 90 * 1000
  const now = Date.now()
  const relevant = (s) => !!(s && s.ts && now - s.ts < FRESH_MS && site && s.source === site.code)
  const { syncProgress, syncResult, forceResync } = await chrome.storage.local.get([
    'syncProgress',
    'syncResult',
    'forceResync'
  ])
  // force 체크박스는 팝업 재실행에도 유지되도록 저장/복원(동기화 완료 시 해제됨).
  const forceEl = $('force')
  if (forceEl) {
    forceEl.checked = !!forceResync
    forceEl.addEventListener('change', () =>
      chrome.storage.local.set({ forceResync: forceEl.checked })
    )
  }
  if (relevant(syncResult) && (!relevant(syncProgress) || syncResult.ts >= syncProgress.ts))
    finishProg(syncResult)
  else if (relevant(syncProgress)) updateProg(syncProgress)
})()

// 동기화 시작: 바를 진행 상태로 초기화
function startProg() {
  $('prog').hidden = false
  $('prog-label').textContent = '가져오는 중…'
  $('prog-txt').textContent = '준비 중…'
  $('fill').style.width = '0%'
  $('fill').classList.remove('done')
}

function updateProg(p) {
  $('prog').hidden = false
  $('prog-label').textContent = '가져오는 중…'
  const pct = p.total ? Math.round((p.done / p.total) * 100) : 0
  $('prog-txt').textContent = `${p.done} / ${p.total} · ${pct}%` // 배지(%)와 대응
  $('fill').style.width = pct + '%'
}

// 동기화 완료: 신규/중복 내역을 명확히 표시. 전부 중복이면 진행 이벤트가
// 한 번도 안 오므로(루프 미실행) 여기서 바를 100%로 채워 "멈춘 것처럼" 보이지 않게 한다.
function finishProg(r) {
  const count = r.count || 0,
    skipped = r.skipped || 0,
    total = r.total || 0
  $('prog').hidden = false
  // force 재수집은 1회성 — 완료되면 체크 해제(다음 동기화가 실수로 전량 재다운로드 방지)
  if ($('force')) $('force').checked = false
  if (r.canceled) {
    // 취소: 바를 100%로 채우지 않고 진행분만 유지. 초록(done) 표시도 안 함.
    $('fill').classList.remove('done')
    $('prog-label').textContent = '중지됨'
    $('prog-txt').textContent = `${count}개 가져오고 중지`
    $('status').textContent = `동기화 중지 · ${count}개 가져옴`
    return
  }
  $('fill').style.width = '100%'
  $('fill').classList.add('done')
  if (total === 0) {
    $('prog-label').textContent = '완료'
    $('prog-txt').textContent = '대화 없음'
    $('status').textContent = '가져올 대화가 없습니다'
  } else if (count === 0) {
    $('prog-label').textContent = '이미 최신'
    $('prog-txt').textContent = `중복 ${skipped}개 건너뜀`
    $('status').textContent = `이미 최신 · ${total}개 모두 보유`
  } else {
    $('prog-label').textContent = '완료'
    $('prog-txt').textContent =
      skipped > 0 ? `신규 ${count}개 · 중복 ${skipped}개 건너뜀` : `신규 ${count}개`
    $('status').textContent = `완료 · ${count}개 가져옴`
  }
}
// 다른 탭/사이트의 진행 메시지가 현재 팝업에 섞이지 않도록 소스를 확인한다.
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'PROGRESS' && site && msg.source === site.code) updateProg(msg)
})

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  )
}

function truncateTitle(title) {
  const t = title || '(제목 없음)'
  return t.length > 26 ? t.slice(0, 26) + '…' : t
}

// 절대 시각 대신 "N일 전" 형태의 상대 시간으로 스캔 가독성을 높인다.
function relativeTime(dateStr) {
  const then = new Date(dateStr).getTime()
  if (Number.isNaN(then)) return ''
  const min = Math.floor((Date.now() - then) / 60000)
  if (min < 1) return '방금 전'
  if (min < 60) return `${min}분 전`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}시간 전`
  return `${Math.floor(hr / 24)}일 전`
}

// 동기화 도중(성공 응답마다 background가 storage를 갱신) 팝업이 열려 있어도
// 최신 목록을 보여주도록 초기 로드와 동기화 완료 시 다시 호출한다.
async function renderRecent() {
  const el = $('recent')
  if (!el) return
  const { recentSyncs } = await chrome.storage.local.get('recentSyncs')
  const items = topRecentSyncs(recentSyncs || [], 10)
  if (items.length === 0) {
    el.innerHTML = `<div class="recent-empty">아직 동기화한 대화가 없어요</div>`
    return
  }
  el.innerHTML =
    `<div class="recent-h">최근 동기화</div>` +
    items
      .map(
        (it) =>
          `<div class="recent-item"><span class="recent-title">${escapeHtml(truncateTitle(it.title))}</span><span class="recent-meta">${escapeHtml(SRC_LABEL[it.source] || it.source)} · ${relativeTime(it.date)}</span></div>`
      )
      .join('')
}
renderRecent()
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.recentSyncs) renderRecent()
})
