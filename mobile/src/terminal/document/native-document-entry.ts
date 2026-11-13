import { createTerminalDocument } from './create-terminal-document'

// Native WebViews use default window seams and page-lifetime listeners; bundle this single startup call and discard its handle.
createTerminalDocument()
