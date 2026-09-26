package expo.modules.orcamobilewebshell;

import java.net.Proxy;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import okhttp3.OkHttpClient;
import okhttp3.Request;
import okhttp3.Response;
import okhttp3.WebSocket;
import okhttp3.WebSocketListener;
import org.json.JSONArray;
import org.json.JSONObject;

final class EngineCdp implements AutoCloseable {
    private final OkHttpClient client;
    private final LinkedBlockingQueue<String> replies = new LinkedBlockingQueue<>(256);
    private WebSocket socket;
    private int sequence;

    EngineCdp() {
        client = new OkHttpClient.Builder().socketFactory(new LocalSocketFactory())
            .proxy(Proxy.NO_PROXY).callTimeout(5, TimeUnit.SECONDS).build();
    }

    JSONArray discover() throws Exception {
        try (Response response = client.newCall(new Request.Builder().url("http://127.0.0.1/json/list").build()).execute()) {
            if (!response.isSuccessful()) throw new IllegalStateException("HTTP " + response.code());
            return new JSONArray(response.body().string());
        }
    }

    void attach(String url) throws Exception {
        java.net.URI uri = new java.net.URI(url);
        if (!"ws".equals(uri.getScheme()) || !"127.0.0.1".equals(uri.getHost()) ||
            !uri.getPath().startsWith("/devtools/page/") || uri.getRawQuery() != null || uri.getRawUserInfo() != null) {
            throw new IllegalStateException("invalid owned target endpoint");
        }
        CompletableFuture<Void> ready = new CompletableFuture<>();
        socket = client.newWebSocket(new Request.Builder().url(url).build(), new WebSocketListener() {
            @Override public void onOpen(WebSocket ws, Response response) { ready.complete(null); }
            @Override public void onMessage(WebSocket ws, String text) {
                if (text.length() > 600000 || !replies.offer(text)) { ws.cancel(); ready.completeExceptionally(new IllegalStateException("queue full")); }
            }
            @Override public void onFailure(WebSocket ws, Throwable error, Response response) {
                ready.completeExceptionally(error);
                replies.offer("{\"transportFailure\":" + JSONObject.quote(error.toString()) + "}");
            }
        });
        ready.get(5, TimeUnit.SECONDS);
    }

    JSONObject command(String method, JSONObject params) throws Exception {
        int id = ++sequence;
        if (!socket.send(new JSONObject().put("id", id).put("method", method).put("params", params).toString())) {
            throw new IllegalStateException("socket closed");
        }
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
        while (System.nanoTime() < deadline) {
            String raw = replies.poll(Math.max(1, deadline - System.nanoTime()), TimeUnit.NANOSECONDS);
            if (raw == null) break;
            JSONObject message = new JSONObject(raw);
            if (message.has("transportFailure")) throw new IllegalStateException(raw);
            if (message.optInt("id") != id) continue;
            if (message.has("error")) throw new IllegalStateException(method + ": " + message.get("error"));
            return message.getJSONObject("result");
        }
        throw new IllegalStateException("CDP timeout: " + method);
    }

    JSONObject command(String method) throws Exception { return command(method, new JSONObject()); }

    @Override public void close() {
        if (socket != null) socket.cancel();
        client.connectionPool().evictAll();
        client.dispatcher().executorService().shutdown();
    }
}
