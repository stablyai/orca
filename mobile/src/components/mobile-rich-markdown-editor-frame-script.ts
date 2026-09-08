import { MOBILE_RICH_MARKDOWN_EDITOR_CHANNEL } from './mobile-rich-markdown-editor-contract'

export const MOBILE_RICH_MARKDOWN_EDITOR_POST_SCRIPT = `
      var frameChannel = ${JSON.stringify(MOBILE_RICH_MARKDOWN_EDITOR_CHANNEL)};

      function post(message) {
        if (window.ReactNativeWebView) {
          window.ReactNativeWebView.postMessage(JSON.stringify(message));
          return;
        }
        if (window.parent !== window) {
          window.parent.postMessage({
            channel: frameChannel,
            frameToken: frameToken,
            direction: 'editor-to-host',
            payload: message
          }, '*');
        }
      }
`

export const MOBILE_RICH_MARKDOWN_EDITOR_HOST_MESSAGE_SCRIPT = `
      window.addEventListener('message', function (event) {
        if (window.parent === window || !frameToken) return;
        var message = event.data;
        if (
          !message ||
          message.channel !== frameChannel ||
          message.frameToken !== frameToken ||
          message.direction !== 'host-to-editor'
        ) {
          return;
        }
        var payload = message.payload;
        if (!payload || typeof payload.type !== 'string') return;
        if (
          payload.type === 'setMarkdown' &&
          typeof payload.markdown === 'string' &&
          Number.isSafeInteger(payload.generation) &&
          payload.generation >= 0
        ) {
          setMarkdown(payload.markdown, payload.generation);
        } else if (payload.type === 'setEditable' && typeof payload.editable === 'boolean') {
          setEditable(payload.editable);
        } else if (payload.type === 'runCommand' && typeof payload.command === 'string') {
          runCommand(payload.command);
        }
      });
`
