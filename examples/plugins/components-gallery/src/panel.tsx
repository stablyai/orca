// No build step: Orca transpiles these files when the panel loads.
import { atom, read, set, Tab, Tabs } from 'orca'
import { ContentTab } from './content'
import { DataTab } from './data'
import { FormsTab } from './forms'

export const tab = atom('gallery.tab', 'forms', { persist: 'plugin' })

export default function Gallery() {
  return (
    <Tabs label="Gallery sections" value={read(tab)} onChange={(value) => set(tab, value)}>
      <Tab value="forms" label="Forms" icon="edit">
        <FormsTab />
      </Tab>
      <Tab value="data" label="Data" icon="database">
        <DataTab />
      </Tab>
      <Tab value="content" label="Content" icon="file-text">
        <ContentTab />
      </Tab>
    </Tabs>
  )
}
