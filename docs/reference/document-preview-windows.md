# Independent document preview windows

Open a Markdown document in rich or preview mode, then choose **More actions →
Open preview in window**. In an HTML document preview, choose **Preview options →
Open preview in window**. Each document has its own native window that can be
moved to another monitor. Opening the same document again reuses its window.

The source tab stays open. Closing that tab leaves the independent preview open;
closing the main Orca window closes the previews too.

Markdown windows show a read-only snapshot of the rendered document, including
unsaved rich-editor content and embedded local images. Reopen the action to
replace the snapshot with the current rendering. Source mode and incomplete
large-document previews cannot produce a snapshot; switch to a rendered mode
first. This prototype does not watch Markdown files or synchronize scrolling.

HTML windows continue reading through the existing document-preview protocol,
including SSH and paired-runtime files. Their separate grant copies the original
document's approved directories and is revoked when the window closes. The View
menu's Reload action reads the file again. Additional directory approval stays
in the original preview: approve the needed directory there, close the independent
window, then open it again. HTML windows have no Orca preload or Node access and
reuse the existing document navigation and network restrictions.

Automated launches use `ORCA_BACKGROUND_LAUNCH=1`; every preview stays hidden.
Unit tests cover sender validation, script isolation, owner preservation, grant
lifetime, failed loads, and background presentation. The Electron rendering test
uses fixture HTML responses so it can check isolated windows without an SSH host.
Moving native windows between physical monitors needs manual testing or an
isolated display.
