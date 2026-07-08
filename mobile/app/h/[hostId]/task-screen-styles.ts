import type { ThemeColors } from '../../../src/theme/mobile-theme'
import { createTaskScreenShellStyles } from './task-screen-shell-styles'
import { createTaskScreenListStyles } from './task-screen-list-styles'
import { createTaskScreenProjectPickerStyles } from './task-screen-project-picker-styles'
import { createTaskScreenDetailStyles } from './task-screen-detail-styles'
import { createTaskScreenDiffCommentStyles } from './task-screen-diff-comment-styles'
import { createTaskScreenCreateFormStyles } from './task-screen-create-form-styles'

export const createTaskScreenStyles = (colors: ThemeColors) => ({
  ...createTaskScreenShellStyles(colors),
  ...createTaskScreenListStyles(colors),
  ...createTaskScreenProjectPickerStyles(colors),
  ...createTaskScreenDetailStyles(colors),
  ...createTaskScreenDiffCommentStyles(colors),
  ...createTaskScreenCreateFormStyles(colors)
})
