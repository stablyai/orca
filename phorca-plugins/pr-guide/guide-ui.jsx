import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CommentPanel } from './comment-ui.jsx'

const tokenPattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\/.*|^\s*#\s.*|\b(?:async|await|break|case|class|const|def|else|export|false|for|from|function|if|import|let|new|null|return|self|throw|true|type|var|while)\b|\b\d+(?:\.\d+)?\b/g

function highlighted(text) {
  const parts = []
  let end = 0
  for (const match of text.matchAll(tokenPattern)) {
    if (match.index > end) parts.push(text.slice(end, match.index))
    const value = match[0]
    const kind = /^["'`]/.test(value) ? 'string' : /^\d/.test(value) ? 'number' : /^\s*(?:\/\/|#)/.test(value) ? 'comment' : 'keyword'
    parts.push(<span className={`token-${kind}`} key={match.index}>{value}</span>)
    end = match.index + value.length
  }
  parts.push(text.slice(end))
  return parts
}

function Diff({ file }) {
  if (!file?.lines?.length) return <p className="empty-diff">This file has no text diff to display.</p>
  return <div className="diff" role="table" aria-label={`Diff for ${file.path}`}>
    {file.lines.map((entry, index) => entry.kind === 'hunk'
      ? <div className="diff-hunk" key={index}>{entry.text}</div>
      : <div className={`diff-row diff-${entry.kind}`} key={index} data-line-type={`change-${entry.kind === 'add' ? 'addition' : entry.kind === 'remove' ? 'deletion' : 'context'}`} data-column-number={entry.line}>
          <span className="line-number">{entry.oldLine ?? ''}</span>
          <span className="line-number">{entry.newLine ?? ''}</span>
          <button type="button" className="line-comment" data-utility-button aria-label={`Comment on line ${entry.line} of ${file.path}`}>+</button>
          <span className="line-sign">{entry.kind === 'add' ? '+' : entry.kind === 'remove' ? '−' : ' '}</span>
          <code>{highlighted(entry.text)}</code>
        </div>
    )}
  </div>
}

export function Guide({ url, headSha, sourceFingerprint, guide, files, root }) {
  const [chapter, setChapter] = useState(0)
  const [openFile, setOpenFile] = useState(0)
  const [reviewed, setReviewed] = useState(() => guide.sections.map(() => false))
  const [otherFiles, setOtherFiles] = useState(false)
  const parts = new URL(url).pathname.split('/')
  const repo = `${parts[1]}/${parts[2]}`
  const number = parts[4]
  const current = guide.sections[chapter]
  const patchFiles = new Map(files.map((file) => [file.path, file]))
  const showChapter = (index) => { setChapter(index); setOpenFile(0); setOtherFiles(false) }
  const completed = reviewed.filter(Boolean).length

  return <div className="guide-shell">
    <aside className="guide-sidebar">
      <div className="brand">PR <span>Guide</span></div>
      <div className="sidebar-label">Review progress</div>
      <div className="progress-track"><div style={{ width: `${Math.round(completed / guide.sections.length * 100)}%` }} /></div>
      <p className="progress-caption">{completed} of {guide.sections.length} chapters reviewed</p>
      <nav aria-label="Guide chapters">
        <div className="sidebar-label">Chapters</div>
        {guide.sections.map((section, index) => <button type="button" key={index} className={`chapter-link ${chapter === index && !otherFiles ? 'active' : ''}`} onClick={() => showChapter(index)}>
          <span className="chapter-index">{String(index + 1).padStart(2, '0')}</span>
          <span>{section.title}</span>
          {reviewed[index] && <span className="reviewed-mark" aria-label="Reviewed">✓</span>}
        </button>)}
        {guide.unplacedFiles.length > 0 && <button type="button" className={`chapter-link ${otherFiles ? 'active' : ''}`} onClick={() => setOtherFiles(true)}><span className="chapter-index">—</span><span>Other files</span></button>}
      </nav>
      <a className="sidebar-pr" href={url} target="_blank" rel="noreferrer">Open PR on GitHub ↗</a>
    </aside>

    <main className="guide-main">
      <header className="guide-header">
        <div className="eyebrow">{repo} <span>·</span> PR #{number} <span>·</span> {headSha.slice(0, 8)}</div>
        <h1>{guide.title}</h1>
        <p>{guide.intent}</p>
      </header>

      {otherFiles ? <section className="chapter-card">
        <div className="eyebrow">Changed files</div>
        <h2>Other files</h2>
        <p>These files are part of the PR but do not belong to a guide chapter.</p>
        <ul className="other-files">{guide.unplacedFiles.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
      </section> : <section className="chapter-card" aria-labelledby="chapter-title">
        <div className="chapter-top"><span className="eyebrow">Chapter {chapter + 1} of {guide.sections.length}</span><label className="review-toggle"><input type="checkbox" checked={reviewed[chapter]} onChange={(event) => setReviewed(reviewed.map((value, index) => index === chapter ? event.target.checked : value))} /> Reviewed</label></div>
        <h2 id="chapter-title">{current.title}</h2>
        <p className="chapter-overview">{current.overview}</p>
        <div className="file-list">
          {current.diffs.map((reference, index) => <article className="file-card" key={reference.file} data-guide-file-shell={reference.file}>
            <button type="button" className="file-heading" aria-expanded={openFile === index} onClick={() => setOpenFile(openFile === index ? -1 : index)}>
              <span><code>{reference.file}</code><small>{reference.summary}</small></span><span aria-hidden="true">{openFile === index ? '−' : '+'}</span>
            </button>
            {openFile === index && <Diff file={patchFiles.get(reference.file)} />}
          </article>)}
        </div>
        <div className="chapter-actions"><button type="button" disabled={chapter === 0} onClick={() => showChapter(chapter - 1)}>← Previous</button><button type="button" disabled={chapter === guide.sections.length - 1} onClick={() => showChapter(chapter + 1)}>Next chapter →</button></div>
      </section>}
    </main>
    <aside className="comment-dock"><CommentPanel root={root} fingerprint={sourceFingerprint} chapters={guide.sections.map((section) => section.title)} /></aside>
  </div>
}

if (typeof document !== 'undefined') {
  const data = JSON.parse(document.getElementById('guide-data').textContent)
  createRoot(document.getElementById('guide-root')).render(<Guide {...data} />)
}
