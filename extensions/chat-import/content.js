// content.js

async function bg(msg) {
  return new Promise((resolve) =>
    chrome.runtime.sendMessage(msg, (resp) => {
      void chrome.runtime.lastError
      resolve(resp)
    })
  )
}
function progress(source, done, total) {
  chrome.runtime.sendMessage({ type: 'PROGRESS', source, done, total }).catch(() => {})
}

const CHUNK = 512 * 1024 // raw 512KB(base64 후 ~683KB, 1MB 상한 미만)
function u8ToB64(u8) {
  let s = ''
  for (let i = 0; i < u8.length; i += 0x8000)
    s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000))
  return btoa(s)
}
async function storeBlob(bytes) {
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK))
  const uploadId = 'up_' + Math.floor(performance.now()) + '_' + bytes.length
  let last
  for (let seq = 0; seq < total; seq++) {
    const part = bytes.subarray(seq * CHUNK, (seq + 1) * CHUNK)
    last = await bg({ type: 'STORE_BLOB', uploadId, seq, total, data: u8ToB64(part) })
    if (!last || last.error) throw new Error((last && last.error) || 'store blob failed')
  }
  return { hash: last.hash, size: last.size }
}

// 동기화 취소 플래그. 팝업의 CANCEL_SYNC로 세팅되고, runSync 루프가 다음 반복
// 직전에 이를 확인해 중단한다.
let cancelRequested = false
// 현재 동기화 진행 여부. 팝업 재오픈 시 SYNC_STATUS로 조회해 버튼 상태를 맞춘다.
let syncingNow = false

// ---- adapters ----
const ADAPTERS = {
  CHATGPT: {
    async _token() {
      const r = await fetch('/api/auth/session', { credentials: 'include' })
      if (!r.ok) throw new Error('re-login to ChatGPT (' + r.status + ')')
      return (await r.json()).accessToken
    },
    async listConversations() {
      const token = await this._token()
      const out = []
      let offset = 0
      for (;;) {
        const r = await fetch(
          `/backend-api/conversations?offset=${offset}&limit=28&order=updated`,
          { headers: { Authorization: 'Bearer ' + token } }
        )
        if (!r.ok) throw new Error('re-login to ChatGPT (' + r.status + ')')
        const data = await r.json()
        for (const it of data.items || [])
          out.push({ externalId: it.id, title: it.title, createdAt: it.create_time })
        if (!data.items || data.items.length < 28) break
        offset += 28
        await Util.sleep(700)
      }
      this._tok = token
      return out
    },
    async fetchConversation(id) {
      const r = await fetch(`/backend-api/conversation/${id}`, {
        headers: { Authorization: 'Bearer ' + this._tok }
      })
      if (!r.ok) throw new Error('chatgpt detail ' + r.status)
      return Normalize.normalizeChatGPT(await r.json(), id)
    },
    attachments(m) {
      const adapter = this
      const atts = (m.metadata && m.metadata.attachments) || []
      return atts.map((a) => ({
        kind: (a.mime_type || '').startsWith('image/') ? 'image' : 'file',
        mime: a.mime_type || 'application/octet-stream',
        name: a.name || 'file',
        size: a.size || 0,
        width: a.width || 0,
        height: a.height || 0,
        fetch: async () => {
          const token = adapter._tok || (await adapter._token())
          const headers = { Authorization: 'Bearer ' + token }
          const dl = await fetch('/backend-api/files/' + a.id + '/download', {
            headers,
            credentials: 'include'
          }).then((r) => r.json())
          if (!dl.download_url) throw new Error('no download_url')
          const buf = await fetch(dl.download_url, { credentials: 'include' }).then((r) =>
            r.arrayBuffer()
          )
          return new Uint8Array(buf)
        }
      }))
    }
  },
  CLAUDE: {
    async _org() {
      const r = await fetch('/api/organizations', { credentials: 'include' })
      if (!r.ok) throw new Error('re-login to Claude (' + r.status + ')')
      const orgs = await r.json()
      return orgs[0].uuid
    },
    async listConversations() {
      this._orgId = await this._org()
      const r = await fetch(`/api/organizations/${this._orgId}/chat_conversations`, {
        credentials: 'include'
      })
      if (!r.ok) throw new Error('re-login to Claude (' + r.status + ')')
      const data = await r.json()
      return (data || []).map((c) => ({
        externalId: c.uuid,
        title: c.name,
        createdAt: c.created_at
      }))
    },
    async fetchConversation(id) {
      // rendering_mode=messages는 content를 [thinking, text, …] 구조화 블록으로 준다
      // (raw는 content가 비고 text에 전부 flatten됨). thinking↔발화 분리를 위해 필수.
      const r = await fetch(
        `/api/organizations/${this._orgId}/chat_conversations/${id}?tree=True&rendering_mode=messages`,
        { credentials: 'include' }
      )
      if (!r.ok) throw new Error('claude detail ' + r.status)
      return Normalize.normalizeClaude(await r.json(), id)
    },
    attachments(m) {
      const out = []
      for (const f of m.files || []) {
        const isImg = f.file_kind === 'image'
        const url = f.preview_url || f.document_asset || f.thumbnail_url
        if (!url) continue
        out.push({
          kind: isImg ? 'image' : 'file',
          mime: isImg ? 'image/*' : 'application/octet-stream',
          name: f.file_name || (isImg ? 'image' : 'file'),
          size: 0,
          width: 0,
          height: 0,
          fetch: async () =>
            new Uint8Array(
              await fetch(url, { credentials: 'include' }).then((r) => r.arrayBuffer())
            )
        })
      }
      for (const a of m.attachments || []) {
        if (!a.extracted_content) continue
        const bytes = new TextEncoder().encode(a.extracted_content)
        out.push({
          kind: 'file',
          mime: 'text/plain',
          name: a.file_name || '붙여넣은 텍스트.txt',
          size: bytes.length,
          width: 0,
          height: 0,
          fetch: async () => bytes
        })
      }
      return out
    }
  },
  GEMINI: {
    _cfg() {
      // content script는 격리 세계라 페이지의 window.WIZ_global_data에 접근 못 하는 게
      // 일반적이다. main 세계에서 값이 보이면 그걸 쓰고, 아니면 페이지 HTML에서 추출한다.
      const g = window.WIZ_global_data
      let at, bl, fsid
      if (g) {
        at = g['SNlM0e']
        bl = g['cfb2h']
        fsid = g['FdrFJe']
      }
      if (!at || !bl || !fsid) {
        const t = Normalize.parseWizTokens(document.documentElement.innerHTML)
        at = at || t.at
        bl = bl || t.bl
        fsid = fsid || t.fsid
      }
      if (!at || !bl || !fsid) throw new Error('re-login to Gemini (no session)')
      return { at, bl, fsid }
    },
    async _rpc(rpcid, inner) {
      const { at, bl, fsid } = this._cfg()
      const url =
        `/_/BardChatUi/data/batchexecute?rpcids=${rpcid}&source-path=%2Fapp` +
        `&bl=${encodeURIComponent(bl)}&f.sid=${encodeURIComponent(fsid)}&hl=ko&_reqid=${Math.floor(Math.random() * 900000)}&rt=c`
      const body = new URLSearchParams()
      body.append('f.req', JSON.stringify([[[rpcid, inner, null, 'generic']]]))
      body.append('at', at)
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body
      })
      if (!r.ok) throw new Error('gemini ' + rpcid + ' ' + r.status)
      return r.text()
    },
    _titles: {},
    async listConversations() {
      // MaZiqc는 한 번에 ~50개만 반환한다. 응답의 nextToken을 [null, token]으로
      // 넘겨 다음 페이지를 이어 받아 전체 대화를 모은다.
      this._titles = {}
      const all = []
      const seen = new Set()
      let token = null
      for (let i = 0; i < 200; i++) {
        // 안전 상한(≈10000개)
        const inner = token === null ? '[]' : JSON.stringify([null, token])
        const text = await this._rpc('MaZiqc', inner)
        const page = Normalize.parseGeminiListPage(text)
        let added = 0
        for (const c of page.items) {
          if (seen.has(c.externalId)) continue
          seen.add(c.externalId)
          this._titles[c.externalId] = c.title // 본문 파싱엔 제목이 없어 캐시
          all.push({ externalId: c.externalId, title: c.title, createdAt: null })
          added += 1
        }
        if (added === 0 || !page.nextToken) break // 새 항목 없음 또는 마지막 페이지
        token = page.nextToken
        await Util.sleep(400)
      }
      return all
    },
    async fetchConversation(id) {
      const cid = id.startsWith('c_') ? id : 'c_' + id
      const text = await this._rpc('hNvQHb', JSON.stringify([cid]))
      return Normalize.normalizeGemini(text, cid, this._titles[id] || this._titles[cid])
    },
    // Gemini 첨부: 메시지 _raw(turn 서브트리)를 재귀 스캔해 googleusercontent 이미지 URL 수집.
    // 문서 파일은 미관찰(후속). URL은 credentials로 직접 fetch.
    attachments(raw) {
      return Normalize.scanGeminiImages(raw).map((f) => ({
        kind: 'image',
        mime: _extMime(f.name),
        name: f.name,
        size: 0,
        width: 0,
        height: 0,
        fetch: async () =>
          new Uint8Array(
            await fetch(f.url, { credentials: 'include' }).then((r) => r.arrayBuffer())
          )
      }))
    }
  }
}

// 파일명 확장자 → 이미지 mime.
function _extMime(name) {
  const e = (String(name).split('.').pop() || '').toLowerCase()
  return (
    {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      webp: 'image/webp',
      gif: 'image/gif'
    }[e] || 'image/png'
  )
}

async function pushWithRetry(conv) {
  // 정규화 산출물엔 updatedAt이 없다. INGEST 페이로드 스키마를 맞추기 위해 push 직전에 채운다.
  conv.updatedAt = conv.updatedAt ?? null
  let resp = await bg({ type: 'PUSH', conv })
  if (resp && resp.ok) return resp
  if (!resp) return { error: 'no response from background' }
  // one retry; back off longer on 429
  await Util.sleep(resp.status === 429 ? 2000 : 700)
  resp = await bg({ type: 'PUSH', conv })
  return resp || { error: 'no response from background' }
}

async function runSync(source, force, opts) {
  const adapter = ADAPTERS[source]
  if (!adapter) return { error: 'unknown source' }
  cancelRequested = false
  const idsResp = await bg({ type: 'GET_INGESTED_IDS', source })
  if (!idsResp || idsResp.error)
    return { error: (idsResp && idsResp.error) || 'no response from background' }
  const skip = new Set(idsResp.ids || [])
  const list = await adapter.listConversations()
  // force면 기존 항목도 다시 받아 덮어쓴다(형식 갱신). 아니면 중복은 건너뜀.
  const todo = force ? list : list.filter((c) => !skip.has(c.externalId))
  const skipped = list.length - todo.length
  let done = 0
  for (const meta of todo) {
    if (cancelRequested) break
    let conv
    try {
      conv = Normalize.ensureNonEmpty(await adapter.fetchConversation(meta.externalId))
    } catch {
      conv = Normalize.titleFallback({
        source,
        externalId: meta.externalId,
        title: meta.title,
        createdAt: meta.createdAt
      })
    }
    // 첨부 캡처는 raw 메시지 서브트리(msg._raw)에서 자산을 fetch→storeBlob 해야 하므로
    // delete msg._raw보다 반드시 먼저 실행해야 한다.
    if (adapter.attachments && opts && (opts.includeImages || opts.includeFiles)) {
      for (const msg of conv.messages) {
        const metas = adapter.attachments(msg._raw || {})
        const refs = []
        for (const meta2 of metas) {
          if (meta2.kind === 'image' && !opts.includeImages) continue
          if (meta2.kind === 'file' && !opts.includeFiles) continue
          // 25MB 초과는 host도 캡을 두지만, 여기서 미리 걸러 업로드 자체를 생략한다.
          if (meta2.size && meta2.size > 25 * 1024 * 1024) continue
          try {
            const bytes = await meta2.fetch()
            // 다운로드 후 크기 재확인: size 메타가 없는 소스(Claude files)는 여기서 상한 적용.
            if (bytes.length > 25 * 1024 * 1024) continue
            const { hash, size } = await storeBlob(bytes)
            if (!hash) continue
            refs.push({
              kind: meta2.kind,
              mimeType: meta2.mime,
              fileName: meta2.name,
              size: size || bytes.length,
              width: meta2.width,
              height: meta2.height,
              hash
            })
          } catch (e) {
            console.debug('attachment skipped:', meta2.name, e && e.message)
          }
        }
        if (refs.length) msg.attachments = refs
        delete msg._raw
      }
    } else {
      for (const msg of conv.messages) delete msg._raw
    }
    for (const msg of conv.messages) delete msg.blocks
    const pushed = await pushWithRetry(conv)
    if (!pushed || pushed.error)
      return {
        error: (pushed && pushed.error) || 'no response from background',
        done,
        total: list.length,
        skipped
      }
    done += 1
    progress(source, done, todo.length)
    if (done < todo.length) await Util.sleep(700)
  }
  const canceled = cancelRequested
  cancelRequested = false
  // 완료(또는 중지) 결과를 background에 알려 storage에 남긴다. 팝업이 닫혀 있어도(또는
  // 전부 중복이라 진행 이벤트가 0건이어도) 재오픈 시 최종 상태를 복원할 수 있게.
  chrome.runtime
    .sendMessage({ type: 'SYNC_DONE', source, count: done, total: list.length, skipped, canceled })
    .catch(() => {})
  return { ok: true, count: done, total: list.length, skipped, canceled }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'SYNC') {
    syncingNow = true
    runSync(msg.source, msg.force, {
      includeImages: msg.includeImages,
      includeFiles: msg.includeFiles
    })
      .then((r) => {
        syncingNow = false
        sendResponse(r)
      })
      .catch((e) => {
        syncingNow = false
        sendResponse({ error: e.message })
      })
    return true
  }
  if (msg.action === 'CANCEL_SYNC') {
    cancelRequested = true
    sendResponse({ ok: true })
    return false
  }
  if (msg.action === 'SYNC_STATUS') {
    // 팝업 재오픈 시 실제 진행 여부를 알려 버튼 상태를 맞춘다.
    sendResponse({ syncing: syncingNow })
    return false
  }
})
