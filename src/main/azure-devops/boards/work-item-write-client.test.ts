import { expect, it } from 'vitest'
import { workItemCommentHtml } from './work-item-write-client'

it('posts agent text as text: markup is escaped and line breaks survive', () => {
  expect(workItemCommentHtml('<img src=x onerror=alert(1)> & "ok"\nnext\r\nlast')).toBe(
    '&lt;img src=x onerror=alert(1)&gt; &amp; "ok"<br>next<br>last'
  )
})
