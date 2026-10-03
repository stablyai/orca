# Independent document preview windows

Open a Markdown document in rich or preview mode, then choose **More actions →
Open preview in window**. In an HTML document preview, choose **Preview options →
Open preview in window**. Each document has its own native window that can be
moved to another monitor. Opening the same document again reuses its window.

The source tab stays open. Closing that tab leaves the independent preview open;
closing the main Orca window closes the previews too.

Markdown windows follow the source file automatically. The viewer checks the same
file every two seconds and updates the rendered document without resetting its
scroll position or raising the window. The source tab can be switched or closed.
Unsaved edits in an open source tab take precedence over disk content.

Local files use the existing editor file-read bridge, pinned to the original local
workspace. SSH and paired-runtime files use a separate document grant pinned to
that host. Disconnects and deleted files retain the last rendered document with a
refresh notice; successful reads clear the notice. Closing the independent window
stops reads and disposes its hidden renderer and grant.

Initial opening still requires rich or preview mode and a complete rendered
Markdown document. If an update exceeds the normal preview size limit, the viewer
keeps the last version and asks the reader to use source view. Scroll synchronization
between the two windows is not enabled.

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
