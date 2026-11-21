import { ExtensionStorage } from '@bacons/apple-targets'
import type { UsageWidgetStorage } from './usage-widget-storage'

// Must match the App Group in app.config.js and the widget's UsageWidgetSummary.swift.
const APP_GROUP = 'group.com.stably.orca.mobile'
const SUMMARY_KEY = 'orca.usageWidget.v1'
const WIDGET_KIND = 'OrcaUsageWidget'

const storage = new ExtensionStorage(APP_GROUP)

export const usageWidgetStorage: UsageWidgetStorage = {
  read: () => storage.get(SUMMARY_KEY),
  write: (json) => {
    storage.set(SUMMARY_KEY, json)
    ExtensionStorage.reloadWidget(WIDGET_KIND)
  }
}
