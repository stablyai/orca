import { createRequire } from 'node:module'

export function parcelWatcherWrapperSource(nativeFilename) {
  const wrapper = createRequire(import.meta.url).resolve('@parcel/watcher/wrapper.js')
  return `const {createWrapper}=require(${JSON.stringify(wrapper)});module.exports=createWrapper(require(${JSON.stringify(nativeFilename)}));`
}

export function bundledParcelWatcherPlugin(nativeFilename) {
  return {
    name: 'bundled-parcel-watcher',
    setup(build) {
      build.onResolve({ filter: /^@parcel\/watcher$/ }, () => ({
        path: 'parcel-watcher',
        namespace: 'bundled-parcel-watcher'
      }))
      build.onLoad({ filter: /.*/, namespace: 'bundled-parcel-watcher' }, () => ({
        contents: parcelWatcherWrapperSource(nativeFilename),
        loader: 'js',
        resolveDir: import.meta.dirname
      }))
      build.onResolve({ filter: /\.node$/, namespace: 'bundled-parcel-watcher' }, (args) => ({
        path: args.path,
        external: true
      }))
    }
  }
}
