import { useEffect, useRef, useState } from 'react'

export function inlineFromPath(path) {
  const element = (node) => node instanceof HTMLElement
  if (!path.some((node) => element(node) && node.hasAttribute('data-utility-button'))) return null
  const row = path.find((node) => element(node) && (node.hasAttribute('data-column-number') || node.hasAttribute('data-line')) && /^change-(addition|deletion|context)$/.test(node.getAttribute('data-line-type') ?? ''))
  const file = path.find((node) => element(node) && node.hasAttribute('data-guide-file-shell'))
  if (!row || !file) return null
  const line = Number(row.getAttribute('data-column-number') ?? row.getAttribute('data-line'))
  if (!Number.isInteger(line) || line < 1) return null
  return { kind: 'inline', path: file.getAttribute('data-guide-file-shell'), line, side: row.getAttribute('data-line-type') === 'change-deletion' ? 'LEFT' : 'RIGHT' }
}

export function CommentPanel({ root, fingerprint, chapters }) {
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('general')
  const [inline, setInline] = useState(null)
  const [destination, setDestination] = useState('github')
  const [sessions, setSessions] = useState([])
  const [session, setSession] = useState('')
  const [body, setBody] = useState('')
  const [status, setStatus] = useState('')
  const [sending, setSending] = useState(false)
  const bodyRef = useRef(null)

  useEffect(() => {
    const labelPlus = (event) => {
      const path = event.composedPath()
      const plus = path.find((node) => node instanceof HTMLElement && node.hasAttribute('data-utility-button'))
      if (plus && path.some((node) => node instanceof HTMLElement && node.hasAttribute('data-guide-file-shell'))) plus.setAttribute('aria-label', 'Comment on this line')
    }
    const selectLine = (event) => {
      const selected = inlineFromPath(event.composedPath())
      if (!selected) return
      event.preventDefault()
      event.stopPropagation()
      setInline(selected)
      setTarget('inline')
      setOpen(true)
      setStatus('')
    }
    const refresh = async () => {
      try {
        const response = await fetch(`${root}/head?fingerprint=${encodeURIComponent(fingerprint)}`)
        const result = await response.json()
        if (result.changed) {
          if (bodyRef.current?.value.trim()) setStatus('PR updated. Copy your draft, then reload this page.')
          else location.reload()
        } else if (result.error) setStatus(`Could not refresh PR: ${result.error}`)
      } catch {
        setStatus('Could not reach the local guide server.')
      }
    }
    for (const name of ['pointerover', 'focusin']) document.addEventListener(name, labelPlus, true)
    document.addEventListener('click', selectLine, true)
    void refresh()
    const timer = setInterval(refresh, 60_000)
    return () => {
      clearInterval(timer)
      for (const name of ['pointerover', 'focusin']) document.removeEventListener(name, labelPlus, true)
      document.removeEventListener('click', selectLine, true)
    }
  }, [root, fingerprint])

  useEffect(() => {
    if (open && target === 'inline') bodyRef.current?.focus()
  }, [open, target, inline])

  useEffect(() => {
    if (destination !== 'local') return
    let active = true
    setSessions([])
    setSession('')
    fetch(`${root}/sessions`)
      .then(async (response) => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Could not list local sessions')
        return result.sessions
      })
      .then((items) => {
        if (!active) return
        setSessions(items)
        setSession(items[0]?.handle ?? '')
        if (!items.length) setStatus('No writable agent session in this worktree.')
      })
      .catch((error) => { if (active) setStatus(error.message) })
    return () => { active = false }
  }, [destination, root])

  async function submit(event) {
    event.preventDefault()
    const selected = target === 'inline' ? inline : target === 'general' ? { kind: 'general' } : { kind: 'section', section: Number(target.slice('section-'.length)) }
    if (!selected || (destination === 'local' && !session)) {
      setStatus('Select a PR line or local agent session.')
      return
    }
    setSending(true)
    setStatus('Sending…')
    try {
      const response = await fetch(`${root}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...selected, body, destination, terminalHandle: destination === 'local' ? session : undefined, sourceFingerprint: fingerprint })
      })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Could not post comment')
      setStatus(destination === 'local' ? `Queued for ${result.session}` : `Posted to GitHub: ${result.url}`)
      setBody('')
    } catch (error) {
      setStatus(error.message)
    } finally {
      setSending(false)
    }
  }

  return <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Comment on PR</summary>
    <form id="pr-guide-form" onSubmit={submit}>
      <label htmlFor="pr-guide-target">Target</label>
      <select id="pr-guide-target" value={target} onChange={(event) => setTarget(event.target.value)}>
        <option value="general">Entire PR</option>
        {chapters.map((title, index) => <option key={index} value={`section-${index}`}>Chapter {index + 1}: {title}</option>)}
        {inline && <option value="inline">{inline.path}:{inline.line} ({inline.side})</option>}
      </select>
      <label htmlFor="pr-guide-destination">Send to</label>
      <select id="pr-guide-destination" value={destination} onChange={(event) => { setDestination(event.target.value); setStatus('') }}>
        <option value="github">GitHub PR</option>
        <option value="local">Local agent session</option>
      </select>
      {destination === 'local' && <>
        <label htmlFor="pr-guide-session">Agent session</label>
        <select id="pr-guide-session" value={session} onChange={(event) => setSession(event.target.value)}>
          {sessions.map((item) => <option key={item.handle} value={item.handle}>{item.agentIdentity}: {item.title}</option>)}
        </select>
      </>}
      <label htmlFor="pr-guide-body">Comment</label>
      <textarea id="pr-guide-body" ref={bodyRef} value={body} onChange={(event) => setBody(event.target.value)} maxLength={10000} required />
      <button type="submit" disabled={sending}>Send comment</button>
      <p id="pr-guide-status" role="status">{status}</p>
    </form>
  </details>
}
