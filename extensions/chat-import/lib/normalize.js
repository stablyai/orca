// lib/normalize.js
function _iso(epochSec) {
  return epochSec != null ? new Date(epochSec * 1000).toISOString() : null
}

// stripWidgets는 ChatGPT 위젯 지시자를 제거한다. 위젯은 PUA(U+E000..U+F8FF) sentinel로
// 감싸인 이름과 그 뒤 균형 잡힌 {...} JSON 페이로드로 나타난다. PUA가 없는 평범한
// snake_case{...}(코드/JSON 등)는 절대 건드리지 않는다.
function stripWidgets(text) {
  if (!text) return text
  const isPUA = (c) => {
    const x = c.codePointAt(0)
    return x >= 0xe000 && x <= 0xf8ff
  }
  let out = ''
  for (let i = 0; i < text.length; ) {
    if (isPUA(text[i])) {
      i++ // opening sentinel
      while (i < text.length && !isPUA(text[i])) i++ // widget name
      if (i < text.length) i++ // closing sentinel
      let j = i
      while (j < text.length && /\s/.test(text[j])) j++
      if (text[j] === '{') {
        // balanced json payload
        let depth = 0,
          k = j
        for (; k < text.length; k++) {
          if (text[k] === '{') depth++
          else if (text[k] === '}') {
            depth--
            if (depth === 0) {
              k++
              break
            }
          }
        }
        if (depth === 0) {
          i = k
          continue
        } // 균형 잡힘 → 페이로드까지 제거
        // 불균형(잘린 JSON): 페이로드는 남겨 뒤 텍스트 삼킴 방지(sentinel+이름만 제거됨)
      }
      continue
    }
    out += text[i]
    i++
  }
  return out
}

// parseBatchEnvelope는 Google batchexecute 응답에서 지정 rpcid의 inner JSON을 뽑는다.
// 응답: )]}'\n\n<바이트길이>\n[["wrb.fr",<rpcid>,"<이스케이프 JSON>",...]] (청크 반복).
// 청크 길이가 UTF-8 바이트 기준이라 멀티바이트에서 슬라이스가 어긋나므로,
// 길이에 의존하지 않고 "wrb.fr",<rpcid>, 다음의 문자열 리터럴을 따옴표 매칭으로 추출한다.
function parseBatchEnvelope(rawText, rpcid) {
  if (!rawText) return null
  const key = '"' + rpcid + '",'
  let p = rawText.indexOf('"wrb.fr","' + rpcid + '",')
  if (p < 0) p = rawText.indexOf(key)
  if (p < 0) return null
  p += p === rawText.indexOf(key) ? key.length : ('"wrb.fr",' + key).length
  while (p < rawText.length && rawText[p] !== '"') p++
  if (p >= rawText.length) return null
  let q = p + 1,
    out = ''
  while (q < rawText.length) {
    const ch = rawText[q]
    if (ch === '\\') {
      out += rawText[q] + rawText[q + 1]
      q += 2
      continue
    }
    if (ch === '"') break
    out += ch
    q++
  }
  try {
    return JSON.parse(JSON.parse('"' + out + '"'))
  } catch (e) {
    return null
  }
}

function normalizeChatGPT(raw, externalId) {
  // current_node에서 parent를 따라 루트까지 수집 후 역순(시간순)
  const chain = []
  let cur = raw.current_node
  while (cur && raw.mapping[cur]) {
    chain.push(raw.mapping[cur])
    cur = raw.mapping[cur].parent
  }
  chain.reverse()
  const messages = []
  for (const node of chain) {
    const m = node.message
    if (!m || !m.author) continue
    const role = m.author.role === 'user' ? 'USER' : m.author.role === 'assistant' ? 'AI' : null
    if (!role) continue
    // text + multimodal_text(이미지 포함) 허용. 이미지는 파트 중 객체라 문자열만 골라 텍스트로.
    if (
      !m.content ||
      (m.content.content_type !== 'text' && m.content.content_type !== 'multimodal_text')
    )
      continue
    const parts = (m.content.parts || []).filter((x) => typeof x === 'string')
    const text = stripWidgets(parts.join('\n')).trim()
    const hasAtt = !!(m.metadata && m.metadata.attachments && m.metadata.attachments.length)
    if (!text && !hasAtt) continue // 텍스트도 첨부도 없으면 스킵
    messages.push({ role, idx: messages.length, text, createdAt: _iso(m.create_time), _raw: m })
  }
  return {
    source: 'CHATGPT',
    externalId,
    title: raw.title || 'Untitled',
    createdAt: _iso(raw.create_time) || null,
    messages
  }
}

// Claude.ai가 클라이언트 미지원 블록에 넣는 플레이스홀더(순수 노이즈)를 제거한다:
// (1) 플레이스홀더만/빈 ```펜스 블록 통째로, (2) 펜스 밖 단독 플레이스홀더 라인,
// (3) 그로 인한 연속 빈 줄 접기. 실제 코드 펜스는 유지.
const CLAUDE_PLACEHOLDER = 'This block is not supported on your current device yet.'
function stripClaudePlaceholder(s) {
  if (!s) return s
  const lines = s.split('\n')
  const out = []
  const push = (ln) => {
    if (ln.trim() === '' && out.length && out[out.length - 1].trim() === '') return
    out.push(ln)
  }
  for (let i = 0; i < lines.length; ) {
    if (lines[i].trim() === '```') {
      let j = i + 1
      while (j < lines.length && lines[j].trim() !== '```') j++
      if (j < lines.length) {
        const inner = lines
          .slice(i + 1, j)
          .join('\n')
          .trim()
        if (inner === '' || inner === CLAUDE_PLACEHOLDER) {
          i = j + 1
          continue
        }
        for (let k = i; k <= j; k++) out.push(lines[k])
        i = j + 1
        continue
      }
    }
    if (lines[i].trim() === CLAUDE_PLACEHOLDER) {
      i++
      continue
    }
    push(lines[i])
    i++
  }
  return out.join('\n')
}

function _claudeText(msg) {
  const raw =
    msg.text && msg.text.trim()
      ? msg.text.trim()
      : (msg.content || [])
          .filter((c) => c.type === 'text')
          .map((c) => c.text)
          .join('\n')
          .trim()
  return stripClaudePlaceholder(raw).trim()
}

// rendering_mode=messages의 content 배열을 [thinking|text] 블록으로 변환한다.
// thinking은 c.thinking, text는 c.text. 그 외(tool_use 등)는 생략.
function _claudeBlocks(msg) {
  const blocks = []
  for (const c of msg.content || []) {
    if (c.type === 'thinking' && c.thinking && c.thinking.trim()) {
      blocks.push({ kind: 'thinking', text: c.thinking.trim() })
    } else if (c.type === 'text' && typeof c.text === 'string') {
      const t = stripClaudePlaceholder(c.text).trim()
      if (t) blocks.push({ kind: 'text', text: t })
    }
  }
  return blocks
}

function normalizeClaude(raw, externalId) {
  const messages = []
  for (const m of raw.chat_messages || []) {
    const role = m.sender === 'human' ? 'USER' : m.sender === 'assistant' ? 'AI' : null
    if (!role) continue
    let blocks = _claudeBlocks(m)
    let text
    if (blocks.length) {
      // text 필드는 검색·미리보기용 — thinking 제외, 답변 텍스트만 합친다.
      text = blocks
        .filter((b) => b.kind === 'text')
        .map((b) => b.text)
        .join('\n\n')
        .trim()
    } else {
      // 구조화 블록이 없으면(구형/raw 응답 등) flat text로 폴백.
      text = _claudeText(m)
      if (text) blocks = [{ kind: 'text', text }]
    }
    const hasAtt = !!((m.files && m.files.length) || (m.attachments && m.attachments.length))
    if (!text && !blocks.length && !hasAtt) continue // 첨부만 있는 메시지도 유지
    messages.push({
      role,
      idx: messages.length,
      text,
      createdAt: m.created_at || null,
      blocks,
      _raw: m
    })
  }
  return {
    source: 'CLAUDE',
    externalId,
    title: raw.name || 'Untitled',
    createdAt: raw.created_at || null,
    messages
  }
}

// parseGeminiListPage는 MaZiqc 응답 한 페이지를 파싱한다.
// inner[2]=대화 행([externalId,title,...]), inner[1]=다음 페이지 토큰(있으면 문자열).
// 반환: { items: [{externalId,title}], nextToken: string|null }. 실패 시 빈 페이지.
function parseGeminiListPage(rawText) {
  const inner = parseBatchEnvelope(rawText, 'MaZiqc')
  if (!inner || !Array.isArray(inner)) return { items: [], nextToken: null }
  const rows = Array.isArray(inner[2]) ? inner[2] : []
  const items = []
  for (const r of rows) {
    if (Array.isArray(r) && typeof r[0] === 'string' && typeof r[1] === 'string') {
      items.push({ externalId: r[0], title: r[1] })
    }
  }
  const nextToken = typeof inner[1] === 'string' && inner[1].length > 0 ? inner[1] : null
  return { items, nextToken }
}

// parseGeminiList는 첫 페이지의 대화 목록만 반환한다(하위호환). 전체 목록은
// 어댑터가 parseGeminiListPage로 nextToken을 따라 페이지네이션한다.
function parseGeminiList(rawText) {
  return parseGeminiListPage(rawText).items
}

function titleFallback(meta) {
  return {
    source: meta.source,
    externalId: meta.externalId,
    title: meta.title || 'Untitled',
    createdAt: meta.createdAt || null,
    messages: [{ role: 'USER', idx: 0, text: meta.title || 'Untitled', createdAt: null }]
  }
}

// getPath는 중첩 배열에서 인덱스 경로를 안전하게 따라간다(중간이 null이면 undefined).
function getPath(node, path) {
  let cur = node
  for (const k of path) {
    if (cur == null) return undefined
    cur = cur[k]
  }
  return cur
}

// normalizeGemini는 hNvQHb 응답에서 사용자/모델 턴을 시간순으로 추출한다.
// 확정 구조(2026-07-02 실측): inner[0]=턴 배열(시간 역순). 턴별:
//   사용자=turn[2][0][0], 모델=turn[3][0][0][1][0], 타임스탬프=turn[4][0](epoch 초).
// 각 값은 문자열일 때만 채택(타입 가드)하여 레이아웃 변경 시 오염 대신 누락으로 실패한다.
// scanGeminiImages는 Gemini turn 서브트리를 재귀 순회해 대화 이미지(googleusercontent /gg/ URL)와
// 인접 파일명을 수집한다. AI 생성·사용자 업로드 모두 이 형태. URL 기준 중복 제거. [{url,name}] 반환.
function scanGeminiImages(node) {
  const out = []
  const seen = new Set()
  const walk = (n) => {
    if (!Array.isArray(n)) return
    for (let i = 0; i < n.length; i++) {
      const v = n[i]
      if (
        typeof v === 'string' &&
        v.indexOf('https:') === 0 &&
        v.indexOf('googleusercontent.com/gg/') >= 0
      ) {
        if (!seen.has(v)) {
          seen.add(v)
          const prev = n[i - 1]
          const name = typeof prev === 'string' && /\.\w{2,5}$/.test(prev) ? prev : 'image'
          out.push({ url: v, name })
        }
      } else if (Array.isArray(v)) {
        walk(v)
      }
    }
  }
  walk(node)
  return out
}

function normalizeGemini(rawText, externalId, title) {
  const inner = parseBatchEnvelope(rawText, 'hNvQHb')
  const turns = inner && Array.isArray(inner) && Array.isArray(inner[0]) ? inner[0] : null
  const messages = []
  if (turns) {
    // 시간 역순 → 역순회로 시간순 정렬
    for (let i = turns.length - 1; i >= 0; i--) {
      const t = turns[i]
      const ts = getPath(t, [4, 0])
      const iso = typeof ts === 'number' ? new Date(ts * 1000).toISOString() : null
      const userText = getPath(t, [2, 0, 0])
      if (typeof userText === 'string' && userText.trim())
        messages.push({
          role: 'USER',
          idx: messages.length,
          text: userText.trim(),
          createdAt: iso,
          _raw: getPath(t, [2])
        })
      const modelText = getPath(t, [3, 0, 0, 1, 0])
      if (typeof modelText === 'string' && modelText.trim())
        messages.push({
          role: 'AI',
          idx: messages.length,
          text: modelText.trim(),
          createdAt: iso,
          _raw: getPath(t, [3])
        })
    }
  }
  return {
    source: 'GEMINI',
    externalId,
    title: title || 'Untitled',
    createdAt: (messages[0] && messages[0].createdAt) || null,
    messages
  }
}

function ensureNonEmpty(conv) {
  if (conv.messages && conv.messages.length) return conv
  return titleFallback({
    source: conv.source,
    externalId: conv.externalId,
    title: conv.title,
    createdAt: conv.createdAt
  })
}

// parseWizTokens는 Gemini 페이지 HTML에서 batchexecute에 필요한 boq 토큰을 추출한다.
// content script는 격리 세계에서 돌아 페이지의 window.WIZ_global_data에 접근할 수 없으므로,
// HTML에 인라인으로 박힌 "KEY":"value" 형태에서 직접 뽑는다.
// at=SNlM0e(XSRF), bl=cfb2h(빌드라벨), fsid=FdrFJe(세션ID). 없으면 해당 값 null.
function parseWizTokens(html) {
  const grab = (k) => {
    const m = (html || '').match(new RegExp('"' + k + '":"([^"]+)"'))
    return m ? m[1] : null
  }
  return { at: grab('SNlM0e'), bl: grab('cfb2h'), fsid: grab('FdrFJe') }
}

const Normalize = {
  stripWidgets,
  normalizeChatGPT,
  normalizeClaude,
  parseGeminiList,
  parseGeminiListPage,
  titleFallback,
  ensureNonEmpty,
  _iso,
  parseBatchEnvelope,
  normalizeGemini,
  parseWizTokens,
  scanGeminiImages
}
if (typeof module !== 'undefined') module.exports = Normalize
if (typeof globalThis !== 'undefined') globalThis.Normalize = Normalize
